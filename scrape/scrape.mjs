// Competition scraper — runs on a GitHub Actions runner.
//
// The tracked sites are all on the Rafflex/GFNI platform, in two generations:
//
//   1. Supabase-backed (Carley, Red Lemon X): a public REST table exposes EXACT,
//      pre-computed data (tickets remaining, per-prize instant-win `found` counts,
//      iw_remaining_value, buyout_cost). We read it directly with the site's own
//      publishable anon key — same data the site ships to every visitor's browser.
//      This is fast and reliable; no headless browser needed. Marked exact.
//
//   2. Livewire-rendered (ODP, Skyline, etc.): figures are rendered into the DOM a
//      few seconds after load. We open each competition in a headless browser, wait
//      for it to settle, and parse the rendered text: price, tickets sold/total,
//      draw date, and the instant-win table (`£X CASH` … `A/B Found`). Top cash
//      prizes shown without a claimed-counter are assumed still available, so this
//      path is marked NOT exact — the app shows it as estimated and says to verify
//      on-site before acting on a buyout.
//
// Output: data/comps.json — the shape the PWA consumes.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const { sites } = JSON.parse(await readFile('probe/sites.json', 'utf8'));
const OUT = 'data/comps.json';
const NAV_TIMEOUT = 45_000;
const SETTLE_MS = 6000;          // wait for Livewire to render numbers
const MAX_COMPS_PER_SITE = 14;   // cap browser work per Livewire site
const LIVEWIRE_CONCURRENCY = 3;  // parallel browser contexts
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// Sites whose public Supabase table we read directly. Keys are publishable
// (anon) keys the sites already expose client-side — read-only.
const SUPABASE = {
  carley:    { url: 'https://sgsusicgxesgcoycruab.supabase.co', key: 'sb_publishable_LQz5eDOG-wmmDDIPkOS2Pg_fJsEIdvk' },
  redlemonx: { url: 'https://qdcmnbnjiflsfzrjpdos.supabase.co', key: 'sb_publishable_5sHEduNc1U3n1dh2_JHuYw_oHmU6PIS' },
};

// Preserve firstSeen across runs so "newest" sorting works.
let prev = { comps: [] };
try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }
const firstSeenById = new Map((prev.comps || []).map((c) => [c.id, c.firstSeen]));

/* ---------- Supabase path (exact) ---------- */

function fromSupabaseRow(siteKey, row) {
  const prizes = Array.isArray(row.iw_prizes) ? row.iw_prizes : [];
  const totalWins = prizes.reduce((n, p) => n + (p.qty || 0), 0);
  const foundWins = prizes.reduce((n, p) => n + (p.found || 0), 0);
  const remainingValue = row.iw_remaining_value != null
    ? row.iw_remaining_value
    : prizes.reduce((n, p) => n + (p.remaining_value ?? Math.max(0, (p.qty - (p.found || 0)) * (p.unit_value || 0))), 0);
  return {
    id: `${siteKey}:${row.id}`,
    siteKey,
    title: row.name || row.id,
    url: row.url,
    price: Number(row.ticket_price) || 0,
    totalTickets: row.total_tickets || 0,
    ticketsSold: row.tickets_sold || 0,
    maxPerPerson: row.max_per_user || null,
    closesAt: row.draw_date || null,
    endPrize: row.end_prize_value ? { desc: 'End prize', value: row.end_prize_value, cashValue: row.end_prize_value } : null,
    instantWins: {
      total: totalWins,
      claimed: foundWins,
      remaining: totalWins - foundWins,
      remainingValue,
      exact: true,
    },
    source: { type: 'supabase', buyoutCost: row.buyout_cost, rtpIwOnly: row.rtp_iw_only, soldPct: row.sold_pct },
  };
}

async function scrapeSupabase(siteKey, cfg) {
  const res = await fetch(`${cfg.url}/rest/v1/competitions?select=*`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`supabase ${res.status}`);
  const rows = await res.json();
  return rows
    .filter((r) => r && r.id && r.total_tickets > 0 && r.ticket_price > 0 && !isJunkTitle(r.name))
    .map((r) => fromSupabaseRow(siteKey, r));
}

// Operators leave test/placeholder comps live (£0 price, "test", "welcome" etc.).
// They can't have EV/buyout maths, so keep them out of the feed.
function isJunkTitle(title) {
  return /\b(test|welcome|check the desc|demo|template|example)\b/i.test(title || '');
}

/* ---------- Livewire path (estimated) ---------- */

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseDrawDate(text) {
  // e.g. "Draw On Fri Jul 31st 7:00pm"
  const m = text.match(/Draw\s+On[^A-Za-z]*[A-Za-z]{3,}\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (mon == null) return null;
  const day = +m[2];
  let hour = +m[3] % 12;
  if (/pm/i.test(m[5])) hour += 12;
  const now = new Date();
  let d = new Date(Date.UTC(now.getUTCFullYear(), mon, day, hour, +m[4]));
  // If that date is well in the past, it's next year's draw.
  if (d.getTime() < now.getTime() - 3 * 24 * 3600e3) d = new Date(Date.UTC(now.getUTCFullYear() + 1, mon, day, hour, +m[4]));
  return d.toISOString();
}

function parseLivewireComp(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const joined = lines.join('\n');

  const iwStart0 = lines.findIndex((l) => /^Instant Win/i.test(l));
  const iwBoundary = iwStart0 >= 0 ? iwStart0 : lines.length;

  // Price: several layouts across the platform's themes.
  let price = 0;
  const totalM = joined.match(/Tickets Total:\s*£\s*([\d.]+)/i);   // "Tickets Total: £3.00"
  const addM = joined.match(/Add\s+(\d+)\s+tickets?\s+to\s+basket/i);
  if (totalM && addM && +addM[1] > 0) price = +totalM[1] / +addM[1];
  if (!price) {
    const perM = joined.match(/£\s*([\d]+(?:\.\d{1,2})?)\s*(?:per|\/)\s*(?:ticket|entry)/i); // "£1.00 Per Ticket"
    if (perM) price = +perM[1];
  }
  if (!price) {
    const pm = joined.match(/(?:^|\n)£\s*(\d{1,2}\.\d{2})(?:\n|$)/); // standalone small £ amount
    if (pm) price = +pm[1];
  }

  // Tickets: take the largest "A/B" ratio that appears BEFORE the instant-win
  // section (that's sold/total; instant-win "A/B Found" ratios come later).
  let ticketsSold = 0, totalTickets = 0;
  for (let i = 0; i < iwBoundary; i++) {
    const m = lines[i].match(/^([\d,]+)\s*\/\s*([\d,]+)$/);
    if (!m) continue;
    const sold = +m[1].replace(/,/g, ''), total = +m[2].replace(/,/g, '');
    if (total > totalTickets && total >= sold) { ticketsSold = sold; totalTickets = total; }
  }

  // Instant wins: prize lines optionally followed by "A/B Found".
  let iwTotal = 0, iwClaimed = 0, iwRemainingValue = 0, iwSeen = 0;
  const iwStart = iwStart0;
  if (iwStart >= 0) {
    for (let i = iwStart + 1; i < lines.length; i++) {
      const pm = lines[i].match(/^£\s*([\d,]+(?:\.\d+)?)\s*(?:CASH|CREDIT|VOUCHER)?$/i)
             || lines[i].match(/^(\d+)p\s*(?:CASH|CREDIT)?$/i);
      if (!pm) continue;
      const value = /p\s*(CASH|CREDIT)?$/i.test(lines[i]) && !lines[i].includes('£')
        ? +pm[1] / 100
        : +pm[1].replace(/,/g, '');
      if (!(value > 0)) continue;
      iwSeen++;
      // Look at the next line for a "A/B Found" counter.
      const fm = (lines[i + 1] || '').match(/^(\d+)\s*\/\s*(\d+)\s*Found$/i);
      if (fm) {
        const found = +fm[1], qty = +fm[2];
        iwTotal += qty; iwClaimed += found;
        iwRemainingValue += Math.max(0, qty - found) * value;
      } else {
        // Top prize with no counter — assume single and still available.
        iwTotal += 1; iwRemainingValue += value;
      }
    }
  }

  return {
    price: Math.round(price * 100) / 100,
    totalTickets, ticketsSold,
    closesAt: parseDrawDate(joined),
    instantWins: iwSeen ? {
      total: iwTotal, claimed: iwClaimed, remaining: iwTotal - iwClaimed,
      remainingValue: Math.round(iwRemainingValue * 100) / 100, exact: false,
    } : { total: null, claimed: null, remaining: null, remainingValue: null, exact: false },
  };
}

// Some sites sit behind Cloudflare's "Just a moment…" JS challenge. A real
// browser usually clears it in a few seconds — poll the title until it changes
// (or give up; the site then simply reports no comps).
async function passCloudflare(page) {
  for (let i = 0; i < 6; i++) {
    const title = await page.title().catch(() => '');
    if (!/just a moment|attention required|checking your browser/i.test(title)) return true;
    await page.waitForTimeout(3000);
  }
  return false;
}

async function scrapeLivewireSite(browser, site) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 }, locale: 'en-GB' });
  const page = await ctx.newPage();
  const comps = [];
  let supabaseRows = null;

  // Bonus: if this "Livewire" site is secretly Supabase, grab that instead.
  page.on('response', async (res) => {
    try {
      if (/\/rest\/v1\/competitions(\?|$)/.test(res.url()) && res.status() === 200) {
        const body = await res.json();
        if (Array.isArray(body) && body.length > 1) supabaseRows = body;
      }
    } catch { /* ignore */ }
  });

  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(4000);
    await passCloudflare(page);
    if (supabaseRows) {
      await ctx.close();
      return supabaseRows.filter((r) => r && r.id && r.total_tickets > 0).map((r) => fromSupabaseRow(site.key, r));
    }
    const links = await page.$$eval('a[href*="/competition"], a[href*="/product"]',
      (as) => [...new Set(as.map((a) => a.href))].filter((h) => !/\/(category|tag|page|about|faq|terms|winner)/i.test(h)));
    for (const url of links.slice(0, MAX_COMPS_PER_SITE)) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await page.waitForTimeout(SETTLE_MS);
        const text = await page.evaluate(() => document.body.innerText);
        const title = await page.evaluate(() => (document.querySelector('h1') || {}).innerText || document.title);
        if (/page not found|404/i.test(title) || isJunkTitle(title)) continue;
        const parsed = parseLivewireComp(text);
        if (!parsed.price || !parsed.totalTickets) continue; // need a real paid comp
        const slug = url.split('/').filter(Boolean).pop();
        comps.push({
          id: `${site.key}:${slug}`, siteKey: site.key, title: title.trim(), url,
          price: parsed.price, totalTickets: parsed.totalTickets, ticketsSold: parsed.ticketsSold,
          maxPerPerson: null, closesAt: parsed.closesAt, endPrize: null,
          instantWins: parsed.instantWins, source: { type: 'livewire-dom' },
        });
      } catch { /* skip this comp */ }
    }
  } catch { /* site-level failure */ }
  await ctx.close();
  return comps;
}

/* ---------- Orchestration ---------- */

const siteMeta = [];
const allComps = [];

// 1. Supabase sites first (fast, exact).
for (const site of sites) {
  if (!SUPABASE[site.key]) continue;
  try {
    const comps = await scrapeSupabase(site.key, SUPABASE[site.key]);
    console.log(`${site.name}: supabase — ${comps.length} comps`);
    siteMeta.push({ key: site.key, name: site.name, url: site.url, platform: 'rafflex/supabase', error: null, compCount: comps.length });
    allComps.push(...comps);
  } catch (err) {
    console.log(`${site.name}: supabase ERROR ${err.message}`);
    siteMeta.push({ key: site.key, name: site.name, url: site.url, platform: 'rafflex/supabase', error: String(err.message), compCount: 0 });
  }
}

// 2. Livewire sites, browser pool with limited concurrency.
const livewireSites = sites.filter((s) => !SUPABASE[s.key]);
const browser = await chromium.launch();
let idx = 0;
async function worker() {
  while (idx < livewireSites.length) {
    const site = livewireSites[idx++];
    try {
      const comps = await scrapeLivewireSite(browser, site);
      const platform = comps[0]?.source?.type === 'supabase' ? 'rafflex/supabase' : 'rafflex/livewire';
      console.log(`${site.name}: ${platform} — ${comps.length} comps`);
      siteMeta.push({ key: site.key, name: site.name, url: site.url, platform, error: comps.length ? null : 'no comps parsed', compCount: comps.length });
      allComps.push(...comps);
    } catch (err) {
      console.log(`${site.name}: ERROR ${err.message}`);
      siteMeta.push({ key: site.key, name: site.name, url: site.url, platform: 'rafflex/livewire', error: String(err.message), compCount: 0 });
    }
  }
}
await Promise.all(Array.from({ length: LIVEWIRE_CONCURRENCY }, worker));
await browser.close();

for (const c of allComps) c.firstSeen = firstSeenById.get(c.id) || new Date().toISOString();
siteMeta.sort((a, b) => sites.findIndex((s) => s.key === a.key) - sites.findIndex((s) => s.key === b.key));

await mkdir('data', { recursive: true });
await writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), sample: false, sites: siteMeta, comps: allComps }, null, 1));
console.log(`\nWrote ${OUT}: ${allComps.length} comps across ${siteMeta.length} sites.`);
