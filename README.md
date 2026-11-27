# Kiosk

Light, local-first news reader (PWA). No framework, no build step, no accounts.
Feeds are fetched by the browser through a tiny CORS proxy; articles are stored on-device in IndexedDB.

## Run locally
    python3 dev_server.py 8080      # then open http://localhost:8080

## Deploy (free)
1. Proxy: `npx wrangler deploy worker.js --name kiosk-proxy` (Cloudflare Workers free tier).
2. App: host this folder on any static host (Cloudflare Pages, GitHub Pages, Netlify).
3. In the app: Settings → Proxy URL → `https://kiosk-proxy.<you>.workers.dev`.

## Keys
j/k next/prev · o open original · s star · m read/unread · r refresh · / search · Esc back

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
