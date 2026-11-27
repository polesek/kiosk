// Cloudflare Worker: CORS proxy for feeds. Deploy with `wrangler deploy` (free tier is plenty).
// Usage: https://<your-worker>.workers.dev/proxy?url=<feed url>
const MAX_BYTES = 5 * 1024 * 1024;
const BLOCKED = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1)/i;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname !== "/proxy") return new Response("Kiosk proxy", { headers: CORS });

    let target;
    try { target = new URL(url.searchParams.get("url")); } catch { return err("bad url", 400); }
    if (!/^https?:$/.test(target.protocol) || BLOCKED.test(target.hostname)) return err("blocked", 400);

    try {
      const res = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Kiosk/1.0)",
          Accept: "application/rss+xml, application/atom+xml, text/xml, text/html, */*",
        },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      const body = await res.arrayBuffer();
      if (body.byteLength > MAX_BYTES) return err("too large", 413);
      return new Response(body, {
        status: res.status,
        headers: { ...CORS, "Content-Type": res.headers.get("Content-Type") || "text/plain", "Cache-Control": "public, max-age=300" },
      });
    } catch (e) {
      return err(String(e), 502);
    }
  },
};

function err(msg, status) {
  return new Response(msg, { status, headers: CORS });
}
