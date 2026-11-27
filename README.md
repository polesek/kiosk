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
Catalog (Polish first, then world/tech), any site URL (auto-discovers its feed), or OPML import/export.
`sources.js` is the catalog; every URL in it was checked to return items.
