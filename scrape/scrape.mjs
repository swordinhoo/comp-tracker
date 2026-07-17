// Competition scraper — runs on a GitHub Actions runner.
//
// Two data paths were found by probing the target sites (all Rafflex/GFNI platform):
//   1. Supabase-backed sites expose /rest/v1/competitions with EXACT, pre-computed
//      fields (tickets_remaining, iw_prizes[].found, iw_remaining_value, buyout_cost).
//      We load the site in a real browser and intercept that response — no API key
//      handling needed, the site authenticates its own request.
//   2. Livewire-rendered sites embed figures in the DOM. We read the rendered comp
//      cards as best-effort and mark the data estimated. Where we can't extract a
//      site cleanly it's flagged so the app shows it as "scrape issue" rather than
//      silently dropping it.
//
// Output: data/comps.json — the shape the PWA consumes.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const { sites } = JSON.parse(await readFile('probe/sites.json', 'utf8'));
const OUT = 'data/comps.json';
const NAV_TIMEOUT = 45_000;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// Load previous output so we can preserve firstSeen timestamps across runs.
let prev = { comps: [] };
try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }
const firstSeenById = new Map((prev.comps || []).map((c) => [c.id, c.firstSeen]));

// Normalise a Supabase `competitions` row into our comp schema.
function fromSupabase(siteKey, row) {
  const prizes = Array.isArray(row.iw_prizes) ? row.iw_prizes : [];
  const totalWins = prizes.reduce((n, p) => n + (p.qty || 0), 0);
  const foundWins = prizes.reduce((n, p) => n + (p.found || 0), 0);
  // iw_remaining_value is authoritative when present; otherwise sum per-prize remainder.
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
      prizes: prizes.map((p) => ({ name: p.name, qty: p.qty, found: p.found || 0, unitValue: p.unit_value })),
      exact: true
    },
    // Site's own computed figures, kept for cross-checking the app's maths.
    source: { type: 'supabase', buyoutCost: row.buyout_cost, rtpIwOnly: row.rtp_iw_only, soldPct: row.sold_pct, scrapedAt: row.scraped_at }
  };
}

async function scrapeSite(browser, site) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 }, locale: 'en-GB' });
  const page = await ctx.newPage();
  const compsById = new Map();
  let platform = 'unknown';

  // Intercept the Supabase competitions list (the whole dataset in one response).
  page.on('response', async (res) => {
    try {
      const u = res.url();
      if (/\/rest\/v1\/competitions(\?|$)/.test(u) && res.status() === 200) {
        const body = await res.json();
        const rows = Array.isArray(body) ? body : [body];
        // The full-list call has no id filter; skip the single-row detail calls.
        if (rows.length > 1 || !/id=eq\./.test(u)) {
          platform = 'rafflex/supabase';
          for (const row of rows) if (row && row.id && row.total_tickets != null) {
            const c = fromSupabase(site.key, row);
            compsById.set(c.id, c);
          }
        }
      }
    } catch { /* ignore non-JSON */ }
  });

  const result = { platform, comps: [], error: null };
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(7000); // allow Supabase/Livewire data to load

    if (compsById.size === 0) {
      // Livewire / server-rendered path: best-effort read of the rendered comp cards.
      platform = 'rafflex/livewire';
      const domComps = await extractLivewire(page, site);
      for (const c of domComps) compsById.set(c.id, c);
    }
  } catch (err) {
    result.error = String(err && err.message || err);
  }

  result.platform = platform;
  result.comps = [...compsById.values()];
  await ctx.close();
  return result;
}

// Best-effort extraction for Livewire sites: pull comp links + visible sold/price text.
// Marked exact:false — good enough for the feed and estimated EV, not for buyout decisions.
async function extractLivewire(page, site) {
  const links = await page.$$eval('a[href*="/competition"]', (as) =>
    [...new Set(as.map((a) => a.href))].slice(0, 40));
  const comps = [];
  for (const url of links.slice(0, 25)) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await page.waitForTimeout(1500);
      const data = await page.evaluate(() => {
        const text = document.body.innerText;
        const num = (re) => { const m = text.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
        return {
          title: (document.querySelector('h1') || {}).innerText || document.title,
          price: num(/£\s?([\d.]+)\s*(?:per|\/)\s*(?:ticket|entry)/i) || num(/ticket[^£]*£\s?([\d.]+)/i),
          soldPct: num(/([\d.]+)\s?%/),
          remaining: num(/([\d,]+)\s*(?:tickets?\s*)?(?:remaining|left)/i),
          total: num(/(?:of|\/)\s*([\d,]+)\s*tickets/i)
        };
      });
      if (!data.price && data.soldPct == null && data.remaining == null) continue;
      const slug = url.split('/').filter(Boolean).pop();
      const total = data.total || (data.remaining != null && data.soldPct != null ? Math.round(data.remaining / (1 - data.soldPct / 100)) : null);
      comps.push({
        id: `${site.key}:${slug}`, siteKey: site.key, title: data.title.trim(), url,
        price: data.price || 0,
        totalTickets: total || 0,
        ticketsSold: total && data.remaining != null ? total - data.remaining : (total && data.soldPct != null ? Math.round(total * data.soldPct / 100) : 0),
        maxPerPerson: null, closesAt: null, endPrize: null,
        instantWins: { total: null, claimed: null, remaining: null, remainingValue: null, exact: false },
        source: { type: 'livewire-dom', soldPct: data.soldPct }
      });
    } catch { /* skip this comp */ }
  }
  return comps;
}

const browser = await chromium.launch();
const allComps = [];
const siteMeta = [];
for (const site of sites) {
  process.stdout.write(`scraping ${site.name}… `);
  const r = await scrapeSite(browser, site);
  console.log(`${r.platform} — ${r.comps.length} comps${r.error ? ' ERROR: ' + r.error : ''}`);
  siteMeta.push({ key: site.key, name: site.name, url: site.url, platform: r.platform, error: r.error, compCount: r.comps.length });
  for (const c of r.comps) {
    c.firstSeen = firstSeenById.get(c.id) || new Date().toISOString();
    allComps.push(c);
  }
}
await browser.close();

await mkdir('data', { recursive: true });
await writeFile(OUT, JSON.stringify({
  updatedAt: new Date().toISOString(),
  sample: false,
  sites: siteMeta,
  comps: allComps
}, null, 1));
console.log(`\nWrote ${OUT}: ${allComps.length} comps across ${siteMeta.length} sites.`);
