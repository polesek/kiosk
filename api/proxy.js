// Vercel serverless proxy: GET /proxy?url=<feed or article URL>  (vercel.json rewrites /proxy -> /api/proxy)
// Lets the browser read feeds and articles that don't send CORS headers. Same API as dev_server.py / worker.js.
const dns = require("node:dns/promises");
const net = require("node:net");

const MAX_BYTES = 4 * 1024 * 1024; // Vercel caps function responses at ~4.5 MB
const UA = "Mozilla/5.0 (compatible; Kiosk/1.0)";

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIp(mapped[1]) : false;
  }
  return true;
}

// Refuse anything that isn't a public http(s) host, so the proxy can't be pointed at internal services.
async function assertPublic(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("blocked host");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("blocked host");
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("method not allowed");

  let target;
  try { target = new URL(req.query.url); } catch { return res.status(400).send("bad url"); }

  try {
    let r, hops = 0;
    for (;;) { // follow redirects by hand so every hop is checked
      await assertPublic(target);
      r = await fetch(target, {
        redirect: "manual",
        signal: AbortSignal.timeout(9000),
        headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, text/xml, text/html, */*" },
      });
      const next = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && next && hops++ < 5) { target = new URL(next, target); continue; }
      break;
    }
    if (Number(r.headers.get("content-length") || 0) > MAX_BYTES) return res.status(413).send("too large");
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > MAX_BYTES) return res.status(413).send("too large");
    res.setHeader("Content-Type", r.headers.get("content-type") || "text/plain");
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.status(r.status).send(body);
  } catch (e) {
    return res.status(502).send(String((e && e.message) || e));
  }
};
