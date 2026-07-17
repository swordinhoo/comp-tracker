# Comp Tracker

A mobile competition-arbitrage tracker (installable PWA) for prize-draw / raffle
sites. It shows a live feed of competitions and works out where the value is:

- **Expected value (EV) per ticket** for every live competition.
- **Buyout detector** — flags a comp the moment the unclaimed instant-win value
  outweighs the cost of buying every remaining ticket (guaranteed-profit floor).
- **Syndicate splitter** — given the per-person ticket cap, how many people are
  needed, the stake and profit per head, and a one-tap "share to group" message.
- **Odds calculator** — exact probability of landing at least one instant win for
  a chosen number of tickets.
- Watchlist, per-site filter, PIN gate, offline support.

## How it works

A scheduled GitHub Actions job (`scrape/scrape.mjs`, every 20 minutes) loads each
tracked site in a headless browser and collects live competition data into
`data/comps.json`. The app reads that file — no server to run.

Tracked sites are listed in `probe/sites.json`.

## Hosting

Served as a static site via GitHub Pages. In **Settings → Pages**, set
**Source → Deploy from a branch → `main` / root**.
