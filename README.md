# Kiosk

Light, local-first news reader (PWA). No framework, no build step, no accounts.
Feeds are fetched by the browser through a tiny CORS proxy; articles are stored on-device in IndexedDB.

## Run locally
    python3 dev_server.py 8080      # then open http://localhost:8080

**Cloudflare**: `npx wrangler deploy worker.js --name kiosk-proxy`, host the folder on any static host (Pages, GitHub Pages,
Netlify), then set Settings → Proxy URL → `https://kiosk-proxy.<you>.workers.dev`.

## Using it
A vertical, full-screen card feed (swipe or scroll; one article per screen). Tap a card to read the full article,
which Kiosk fetches and extracts with [Mozilla Readability](https://github.com/mozilla/readability) (vendored in `vendor/`).
The sidebar only appears when you press ☰.
Keys: j/k or ↓/↑ next/prev · Enter read · o open original · s star · r refresh · / search · Esc close

## Add sources
First run opens a personalization screen: pick languages (Polski / English) and categories, tick sources, done.
It is also available from the menu → Add sources. Any site URL works too (its feed is auto-discovered), as does OPML import/export.

## The source catalog
`sources.js` is **generated** — don't edit it by hand. `python3 tools/harvest.py` rebuilds it from:
- `tools/curated.json` — hand-picked feeds
- `tools/sites.json` — hand-picked site homepages (the feed is discovered automatically)
- [plenaryapp/awesome-rss-feeds](https://github.com/plenaryapp/awesome-rss-feeds) (CC0) — OPML lists by country and topic
- Wikidata — newspapers and news sites for Poland, the UK and the US

Only feeds that currently return recent articles are kept. Wikidata rate-limits to ~1 query/minute, so a cold run takes
~15 min; results are cached for 14 days in `tools/.cache/`. To add a source, put it in `curated.json` or `sites.json` and re-run.
