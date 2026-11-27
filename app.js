import { CATALOG } from "./sources.js";

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const rtf = new Intl.RelativeTimeFormat(navigator.language, { numeric: "auto", style: "narrow" });
function ago(ts) {
  const s = Math.round((ts - Date.now()) / 1000), a = Math.abs(s);
  if (a < 60) return rtf.format(0, "second");
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  return new Date(ts).toLocaleDateString();
}
let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------- IndexedDB (articles) ---------- */
const DB = (() => {
  let p;
  const open = () => (p ||= new Promise((res, rej) => {
    const r = indexedDB.open("feedlight", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("articles", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction("articles", mode);
      const out = fn(t.objectStore("articles"));
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    all: () => tx("readonly", (s) => s.getAll()),
    put: (a) => tx("readwrite", (s) => void s.put(a)),
    putMany: (arr) => tx("readwrite", (s) => void arr.forEach((a) => s.put(a))),
    del: (ids) => tx("readwrite", (s) => void ids.forEach((i) => s.delete(i))),
    clear: () => tx("readwrite", (s) => void s.clear()),
  };
})();

/* ---------- state ---------- */
let feeds = store.get("feeds", []);
// One-time reset: schema 1 shipped with pre-subscribed starter feeds. Start empty instead.
// Safe to delete once every browser using the app has run it.
if (store.get("schema", 1) < 2) {
  feeds = [];
  store.set("feeds", feeds); store.set("lastRefresh", 0); store.set("schema", 2);
  DB.clear().catch(() => {});
}
let articles = [];
let view = { kind: "all", feed: null, cat: null };
let query = "";
let unreadOnly = store.get("unreadOnly", true);
let order = store.get("order", "shuffle"); // "shuffle" | "newest"
let seed = Math.random();
let shown = 30;
let selectedId = null;
let refreshing = false;
let visibleIds = [];
const PER_FEED = 150, PAGE = 30;

/* ---------- networking ---------- */
function proxyUrl(u) {
  const base = (store.get("proxy", "") || "").replace(/\/+$/, "");
  return `${base}/proxy?url=${encodeURIComponent(u)}`;
}
async function fetchText(u) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(proxyUrl(u), { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    const head = new TextDecoder("latin1").decode(buf.slice(0, 1024));
    const enc =
      (r.headers.get("content-type") || "").match(/charset=([\w-]+)/i)?.[1] ||
      head.match(/<\?xml[^>]*encoding=["']([\w-]+)/i)?.[1] ||
      head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || "utf-8";
    let dec;
    try { dec = new TextDecoder(enc); } catch { dec = new TextDecoder("utf-8"); }
    return dec.decode(buf);
  } finally { clearTimeout(t); }
}

/* ---------- parsing ---------- */
function sanitize(html, base) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  doc.querySelectorAll("script,style,iframe,object,embed,form,link,meta,noscript,svg,math,base").forEach((n) => n.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith("on") || n === "style" || n === "srcdoc") el.removeAttribute(a.name);
    }
    for (const attr of ["href", "src"]) {
      if (!el.hasAttribute(attr)) continue;
      const v = el.getAttribute(attr).trim();
      if (/^(javascript|data|vbscript):/i.test(v) && !(attr === "src" && /^data:image\//i.test(v))) { el.removeAttribute(attr); continue; }
      try { el.setAttribute(attr, new URL(v, base).href); } catch {}
    }
    if (el.tagName === "A") { el.target = "_blank"; el.rel = "noopener noreferrer"; }
    if (el.tagName === "IMG") { el.loading = "lazy"; el.referrerPolicy = "no-referrer"; el.removeAttribute("width"); el.removeAttribute("height"); el.removeAttribute("srcset"); }
  });
  return doc.body.innerHTML;
}
const textOf = (html) => new DOMParser().parseFromString(html || "", "text/html").body.textContent.replace(/\s+/g, " ").trim();
const first = (el, ...names) => {
  for (const n of names) { const e = el.getElementsByTagName(n)[0]; if (e && e.textContent.trim()) return e.textContent.trim(); }
  return "";
};

function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror") || !doc.documentElement) throw new Error("Not a valid feed");
  const atom = doc.documentElement.localName === "feed";
  const nodes = [...doc.getElementsByTagName(atom ? "entry" : "item")];
  if (!nodes.length && !["rss", "feed", "RDF"].includes(doc.documentElement.localName)) throw new Error("Not a feed");
  const items = nodes.map((n) => {
    let link = "";
    if (atom) {
      const ls = [...n.getElementsByTagName("link")];
      link = (ls.find((l) => (l.getAttribute("rel") || "alternate") === "alternate") || ls[0])?.getAttribute("href") || "";
    } else link = first(n, "link") || first(n, "guid");
    const raw = first(n, "content:encoded", "content", "description", "summary");
    const html = sanitize(raw, link || undefined);
    const dateStr = first(n, "pubDate", "dc:date", "published", "updated");
    let date = Date.parse(dateStr);
    if (Number.isNaN(date)) date = 0;
    let img = n.getElementsByTagName("media:thumbnail")[0]?.getAttribute("url") ||
      [...n.getElementsByTagName("media:content")].find((m) => /image/.test(m.getAttribute("medium") || m.getAttribute("type") || "image"))?.getAttribute("url") ||
      [...n.getElementsByTagName("enclosure")].find((e) => /^image\//.test(e.getAttribute("type") || ""))?.getAttribute("url") || "";
    if (!img) img = new DOMParser().parseFromString(html, "text/html").querySelector("img")?.getAttribute("src") || "";
    return {
      title: textOf(first(n, "title")) || "(untitled)",
      link, guid: first(n, "guid", "id"), date, html, img,
      snippet: textOf(html).slice(0, 220),
    };
  });
  return { title: textOf(first(doc.documentElement, "title")), items };
}

/* ---------- refresh ---------- */
async function refreshFeed(f) {
  const { title, items } = parseFeed(await fetchText(f.url));
  if (!f.name && title) f.name = title;
  f.error = null;
  const known = new Set(articles.filter((a) => a.feed === f.url).map((a) => a.id));
  const now = Date.now(), fresh = [];
  for (const it of items) {
    const id = `${f.url}|${it.guid || it.link || it.title}`;
    if (known.has(id)) continue;
    fresh.push({ id, feed: f.url, ...it, date: it.date || now, read: false, star: false, added: now });
  }
  if (fresh.length) { await DB.putMany(fresh); articles.push(...fresh); }
  const mine = articles.filter((a) => a.feed === f.url && !a.star).sort((a, b) => b.date - a.date);
  const drop = mine.slice(PER_FEED);
  if (drop.length) { await DB.del(drop.map((a) => a.id)); const gone = new Set(drop.map((a) => a.id)); articles = articles.filter((a) => !gone.has(a.id)); }
  return fresh.length;
}

async function refreshAll(list = feeds) {
  if (refreshing || !list.length) return;
  refreshing = true; $("#btn-refresh").classList.add("busy");
  const queue = [...list]; let done = 0, fails = 0, added = 0;
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      try { added += await refreshFeed(f); } catch (e) { f.error = String(e.message || e); fails++; console.warn("feed failed:", f.url, f.error); }
      $("#progress").style.transform = `scaleX(${++done / list.length})`;
      if (done % 4 === 0) renderAll();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  store.set("feeds", feeds); store.set("lastRefresh", Date.now());
  refreshing = false; $("#btn-refresh").classList.remove("busy");
  setTimeout(() => ($("#progress").style.transform = "scaleX(0)"), 400);
  renderAll();
  toast(fails ? `${added} new · ${fails} feed(s) failed` : added ? `${added} new articles` : "Up to date");
}

/* ---------- ordering ---------- */
const feedOf = (url) => feeds.find((f) => f.url === url);
const keep = new Set(); // articles viewed this session: they stay in the feed even though they're now "read"

function filtered() {
  let list = articles;
  if (view.kind === "unread") list = list.filter((a) => !a.read || keep.has(a.id));
  else if (view.kind === "star") list = list.filter((a) => a.star);
  else if (view.kind === "feed") list = list.filter((a) => a.feed === view.feed);
  else if (view.kind === "cat") { const urls = new Set(feeds.filter((f) => (f.cat || "Other") === view.cat).map((f) => f.url)); list = list.filter((a) => urls.has(a.feed)); }
  if (unreadOnly && !["unread", "star"].includes(view.kind)) list = list.filter((a) => !a.read || keep.has(a.id));
  if (query) { const q = query.toLowerCase(); list = list.filter((a) => a.title.toLowerCase().includes(q) || a.snippet.toLowerCase().includes(q)); }
  list = [...list].sort((a, b) => b.date - a.date);
  return order === "shuffle" && !query && view.kind !== "star" ? mix(list) : list;
}

// Stable pseudo-random key in [0,1) for a string + the current seed, so the order doesn't jump
// when the list re-renders. Changing `seed` reshuffles.
function rand(str) {
  let h = 2166136261 ^ Math.floor(seed * 4294967296);
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// Shuffle each source's articles, then deal them out in rounds: every round takes one article from each
// source that still has some, with the sources in a fresh random order each time. This keeps one busy
// outlet from filling the feed without the result looking like a fixed rotation.
function mix(list) {
  const lanes = new Map();
  for (const a of list) (lanes.get(a.feed) || lanes.set(a.feed, []).get(a.feed)).push(a);
  const ordered = [...lanes.entries()].map(([f, l]) => [f, l.sort((x, y) => rand(x.id) - rand(y.id))]);
  const out = [];
  for (let i = 0; ordered.some(([, l]) => i < l.length); i++) {
    ordered.filter(([, l]) => i < l.length).sort((x, y) => rand(x[0] + "#" + i) - rand(y[0] + "#" + i)).forEach(([, l]) => out.push(l[i]));
  }
  return out;
}

/* ---------- feed (full-screen cards) ---------- */
const hueOf = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const paintHues = (root) => $$("[data-h]", root).forEach((el) => el.style.setProperty("--h", el.dataset.h));
let current = [];       // the full ordered list for the current view
let rendered = 0;       // how many of `current` have cards on screen

function cardHTML(a) {
  const f = feedOf(a.feed), name = f?.name || "";
  return `<article class="card ${a.read ? "seen" : ""}" data-id="${esc(a.id)}" data-h="${hueOf(name)}">
    ${a.img ? `<img class="bgimg" src="${esc(a.img)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : ""}
    <div class="inner">
      ${a.img ? `<img class="hero" src="${esc(a.img)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : `<div class="hero ph" aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</div>`}
      <div class="meta"><span class="src">${esc(name)}</span><span>${ago(a.date)}</span></div>
      <h2>${esc(a.title)}</h2>
      ${a.snippet ? `<p class="snip">${esc(a.snippet)}</p>` : ""}
      <div class="cta"><button class="read" data-act="read">Read article <span aria-hidden="true">→</span></button></div>
      <div class="rail">
        <button data-act="star" class="${a.star ? "on" : ""}" aria-label="Star" title="Star (s)">${a.star ? "★" : "☆"}</button>
        <button data-act="orig" aria-label="Open original" title="Open original (o)">↗</button>
        ${navigator.share ? '<button data-act="share" aria-label="Share" title="Share">⤴</button>' : ""}
      </div>
    </div></article>`;
}
const endCardHTML = () => `<article class="card end" data-h="210"><div class="inner center">
  <div class="big">✓</div><h2>You're all caught up</h2><p class="snip">That's everything for now.</p>
  <div class="cta"><button class="read" data-act="reshuffle">⇄ Shuffle again</button><button class="read ghost" data-act="refresh">⟳ Check for new</button></div></div></article>`;

const seenTimers = new Map();
const seenIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const id = e.target.dataset.id; if (!id) continue;
    if (e.isIntersecting) { if (!seenTimers.has(id)) seenTimers.set(id, setTimeout(() => markSeen(id), 900)); }
    else { clearTimeout(seenTimers.get(id)); seenTimers.delete(id); }
  }
}, { root: $("#feed"), threshold: 0.7 });
const moreIO = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) appendCards(); }, { root: $("#feed"), threshold: 0.3 });

function markSeen(id) {
  seenTimers.delete(id);
  const a = articles.find((x) => x.id === id); if (!a) return;
  keep.add(id);
  if (!a.read) { a.read = true; DB.put(a); clearTimeout(markSeen.t); markSeen.t = setTimeout(renderSide, 400); }
  $(`.card[data-id="${CSS.escape(id)}"]`)?.classList.add("seen");
}

function appendCards() {
  moreIO.disconnect();
  const feedEl = $("#feed");
  if (rendered >= current.length) return;
  const end = Math.min(current.length, rendered + PAGE);
  feedEl.querySelector(".card.end")?.remove();
  feedEl.insertAdjacentHTML("beforeend", current.slice(rendered, end).map(cardHTML).join("") + (end >= current.length ? endCardHTML() : ""));
  rendered = end;
  paintHues(feedEl);
  observeCards();
}
function observeCards() {
  const cards = $$("#feed .card[data-id]");
  cards.forEach((c) => seenIO.observe(c));
  if (rendered < current.length && cards.length) moreIO.observe(cards[Math.max(0, cards.length - 5)]);
}

function renderFeed() {
  const feedEl = $("#feed");
  seenIO.disconnect(); moreIO.disconnect(); seenTimers.forEach(clearTimeout); seenTimers.clear();
  current = filtered(); rendered = 0;
  if (!feeds.length) {
    feedEl.innerHTML = `<article class="card" data-h="215"><div class="inner center"><div class="big">📰</div><h2>Your feed is empty</h2><p class="snip">Tell us what you like and we'll fill it with articles.</p><div class="cta"><button class="read" data-act="onboard">Choose your interests</button></div></div></article>`;
  } else if (!current.length) {
    feedEl.innerHTML = `<article class="card" data-h="215"><div class="inner center"><div class="big">${refreshing || !articles.length ? "⏳" : "✓"}</div><h2>${refreshing || !articles.length ? "Loading articles…" : query ? "No matches" : "Nothing here"}</h2><p class="snip">${refreshing || !articles.length ? "Fetching your sources." : ""}</p></div></article>`;
  } else {
    feedEl.innerHTML = "";
    appendCards();
  }
  paintHues(feedEl);
  $("#title").textContent = (view.kind === "feed" ? feedOf(view.feed)?.name : view.kind === "cat" ? view.cat : { all: "For you", unread: "Unread", star: "Starred" }[view.kind]) || "For you";
  $("#btn-shuffle").classList.toggle("on", order === "shuffle");
}

function renderSide() {
  const counts = {}; let unread = 0, stars = 0;
  for (const a of articles) { if (!a.read) { counts[a.feed] = (counts[a.feed] || 0) + 1; unread++; } if (a.star) stars++; }
  $("#n-all").textContent = articles.length || ""; $("#n-unread").textContent = unread || ""; $("#n-star").textContent = stars || "";
  $$("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === view.kind));
  const cats = {};
  for (const f of feeds) (cats[f.cat || "Other"] ||= []).push(f);
  $("#feeds").innerHTML = Object.entries(cats).map(([c, fs]) => {
    const cu = fs.reduce((s, f) => s + (counts[f.url] || 0), 0);
    return `<button class="cat-row ${view.kind === "cat" && view.cat === c ? "on" : ""}" data-cat="${esc(c)}">${esc(c)}<span class="n">${cu || ""}</span></button>` +
      fs.map((f) => `<div class="feed-row ${view.kind === "feed" && view.feed === f.url ? "on" : ""} ${f.error ? "err" : ""}" data-feed="${esc(f.url)}" title="${esc(f.error || f.url)}" tabindex="0" role="button"><span class="nm">${esc(f.name || f.url)}</span><span class="n">${counts[f.url] || ""}</span><button class="rm" data-rm="${esc(f.url)}" aria-label="Remove">✕</button></div>`).join("");
  }).join("") || `<p class="muted pad">No sources yet.</p>`;
}
function renderAll() { renderSide(); renderFeed(); }

/* ---------- actions ---------- */
async function patch(a, props) { Object.assign(a, props); await DB.put(a); }
function setView(v) {
  view = v; keep.clear(); shown = PAGE;
  $("#app").classList.remove("menu");
  renderAll(); $("#feed").scrollTop = 0;
}
const cardOf = (id) => $(`.card[data-id="${CSS.escape(id)}"]`);
const currentCard = () => {
  const feedEl = $("#feed"), mid = feedEl.getBoundingClientRect().top + feedEl.clientHeight / 2;
  return $$("#feed .card").find((c) => { const r = c.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; });
};
function step(d) {
  const cards = $$("#feed .card"), c = currentCard(); if (!c) return;
  cards[Math.max(0, Math.min(cards.length - 1, cards.indexOf(c) + d))]?.scrollIntoView({ behavior: "smooth", block: "start" });
}
async function toggleStar(id) {
  const a = articles.find((x) => x.id === id); if (!a) return;
  await patch(a, { star: !a.star });
  const b = cardOf(id)?.querySelector('[data-act="star"]');
  if (b) { b.classList.toggle("on", a.star); b.textContent = a.star ? "★" : "☆"; }
  if (readerId === id) renderReader(a); renderSide();
}
function reshuffle() {
  if (order !== "shuffle") { order = "shuffle"; store.set("order", order); }
  seed = Math.random(); keep.clear(); renderFeed(); $("#feed").scrollTop = 0;
}

async function addFeed(f) {
  if (feeds.some((x) => x.url === f.url)) return false;
  const nf = { url: f.url, name: f.name || "", cat: f.cat || "Other", lang: f.lang };
  feeds.push(nf); store.set("feeds", feeds); renderSide();
  refreshFeed(nf).catch((e) => { nf.error = String(e.message || e); }).finally(() => { store.set("feeds", feeds); renderAll(); });
  return true;
}
async function removeFeed(url) {
  const f = feedOf(url);
  if (!f || !confirm(`Remove “${f.name || url}” and its articles?`)) return;
  feeds = feeds.filter((x) => x.url !== url); store.set("feeds", feeds);
  const ids = articles.filter((a) => a.feed === url && !a.star).map((a) => a.id);
  await DB.del(ids); const gone = new Set(ids); articles = articles.filter((a) => !gone.has(a.id));
  if (view.feed === url) view = { kind: "all" };
  renderAll();
}

/* ---------- reader (full article) ---------- */
let readerId = null;
// Likely "subscriber only" wording on a publisher page (Polish + English). Used only to explain
// why the full text isn't available; Kiosk does not try to get around paywalls.
const PAYWALL_RE = /(tylko dla (subskrybent|prenumerator|zalogowan)|dla (subskrybent|prenumerator)ów|artyku[łl] (premium|dla prenumerator)|treść (jest )?dostępna (tylko )?(po|dla)|wykup (dostęp|prenumeratę)|subscribers? only|subscribe to (read|continue)|premium (content|article)|paywall|members[- ]only)/i;

async function loadFull(a) {
  if (a.full || a.fullFailed || !a.link) return;
  const html = await fetchText(a.link);
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.head.prepend(Object.assign(doc.createElement("base"), { href: a.link }));
  const art = new Readability(doc, { charThreshold: 250 }).parse();
  const text = art ? textOf(art.content) : "";
  const have = textOf(a.html).length;
  if (!art || text.length < Math.max(400, have * 1.25)) {
    a.fullFailed = true;
    a.paywall = PAYWALL_RE.test(html) || /premium|wyborcza\.pl\/.*(magazyn|prenumerat)/i.test(a.link);
  } else a.full = sanitize(art.content, a.link);
  DB.put(a);
}

function renderReader(a, status) {
  const f = feedOf(a.feed), body = a.full || a.html;
  const site = (() => { try { return new URL(a.link).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  $("#r-star").textContent = a.star ? "★" : "☆";
  $("#reader-body").innerHTML = `
    <h2>${esc(a.title)}</h2>
    <div class="r-meta">${esc(f?.name || "")} · ${new Date(a.date).toLocaleString()}</div>
    ${a.img && !body.includes(a.img) ? `<img class="r-hero" src="${esc(a.img)}" alt="" referrerpolicy="no-referrer">` : ""}
    ${status === "loading" ? `<p class="r-note"><span class="spin"></span> Loading the full article…</p>` : ""}
    ${a.paywall && !a.full ? `<div class="r-lock"><strong>🔒 Subscriber-only article</strong><p>${esc(f?.name || site)} only shares a preview here. Open it on their site, where you can sign in with your own subscription.</p><a class="btn primary" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">Open on ${esc(site)} ↗</a></div>` : ""}
    <div class="r-content">${body}</div>
    ${!a.full && !a.paywall && status === "done" && a.link ? `<p class="r-note">Couldn't load the full text. <a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">Open original ↗</a></p>` : ""}`;
}
function openReader(id) {
  const a = articles.find((x) => x.id === id); if (!a) return;
  readerId = id; markSeen(id);
  renderReader(a, !a.full && !a.fullFailed && a.link ? "loading" : "done");
  $("#reader").classList.add("open"); $("#reader").setAttribute("aria-hidden", "false"); $("#reader .sheet").scrollTop = 0;
  history.pushState({ reader: true }, "");
  if (!a.full && !a.fullFailed && a.link) loadFull(a).catch(() => { a.fullFailed = true; }).finally(() => { if (readerId === id) renderReader(a, "done"); });
}
function closeReader(fromUI = true) {
  if (!readerId) return;
  readerId = null; $("#reader").classList.remove("open"); $("#reader").setAttribute("aria-hidden", "true");
  if (fromUI && history.state?.reader) history.back();
}
addEventListener("popstate", () => closeReader(false));

/* ---------- onboarding: interests -> suggested sources ---------- */
const INTERESTS = [
  { id: "news", emoji: "📰", en: "News", pl: "Wiadomości", hue: 215, cats: ["Polska", "World", "United Kingdom", "United States", "News"] },
  { id: "biz", emoji: "💼", en: "Business", pl: "Biznes", hue: 150, cats: ["Biznes PL", "Business & Economy", "Personal finance", "Startups"] },
  { id: "tech", emoji: "💻", en: "Tech", pl: "Technologie", hue: 265, cats: ["Tech PL", "Tech", "Programming", "Cyber security", "Apple", "Android", "Web Development", "UI - UX", "Android Development", "iOS Development"] },
  { id: "science", emoji: "🔬", en: "Science & space", pl: "Nauka i kosmos", hue: 185, cats: ["Nauka PL", "Science", "Space", "Environment", "Nature", "Animal & Wildlife"] },
  { id: "sport", emoji: "⚽", en: "Sport", pl: "Sport", hue: 25, cats: ["Sport PL", "Sports", "Football", "Tennis", "Cricket", "Chess"] },
  { id: "culture", emoji: "🎬", en: "Culture", pl: "Kultura", hue: 330, cats: ["Kultura i moto PL", "Movies", "Television", "Music", "Books", "Photography", "Architecture", "Interior design", "History"] },
  { id: "gaming", emoji: "🎮", en: "Gaming", pl: "Gry", hue: 285, cats: ["Gaming"] },
  { id: "crypto", emoji: "₿", en: "Crypto", pl: "Krypto", hue: 45, cats: ["Cryptocurrency"] },
  { id: "life", emoji: "🧳", en: "Life & style", pl: "Styl życia", hue: 5, cats: ["Food", "Travel", "DIY", "Fashion", "Beauty", "Cars"] },
];
const ob = { langs: new Set(["pl", "en"]), ints: new Set(), picked: new Map(), auto: new Map(), expanded: new Set(), q: "" };
const AUTO_PICK = 4, CHIPS = 10;

function obPool(i) {
  const seen = new Set();
  return CATALOG.filter((s) => ob.langs.has(s.lang) && i.cats.includes(s.cat) && !seen.has(s.url) && seen.add(s.url))
    .sort((a, b) => (b.top ? 1 : 0) - (a.top ? 1 : 0)); // well-known first; stable sort keeps catalog order otherwise
}
function obTiles() {
  $("#ob-tiles").innerHTML = INTERESTS.map((i) => `<button class="tile ${ob.ints.has(i.id) ? "on" : ""}" data-int="${i.id}" data-h="${i.hue}">
    <span class="emo">${i.emoji}</span><span class="tn">${i.en}</span><span class="tp">${i.pl}</span><span class="chk">✓</span></button>`).join("");
  paintHues($("#ob-tiles"));
}
function chip(s, have) {
  const on = ob.picked.has(s.url);
  return `<button class="chip ${on ? "on" : ""} ${have.has(s.url) ? "added" : ""}" data-src="${esc(s.url)}" ${have.has(s.url) ? "disabled" : ""} data-h="${hueOf(s.name)}">
    <span class="av">${esc(s.name.charAt(0).toUpperCase())}</span><span class="nm">${esc(s.name)}</span><span class="tick">${have.has(s.url) ? "added" : "✓"}</span></button>`;
}
function obSuggest() {
  const have = new Set(feeds.map((f) => f.url)), q = ob.q.trim().toLowerCase();
  let html = "";
  if (q) {
    const res = CATALOG.filter((s) => ob.langs.has(s.lang) && `${s.name} ${s.cat}`.toLowerCase().includes(q)).slice(0, 36);
    html = res.length ? `<div class="sugg"><h3>Search results</h3><div class="chips-grid">${res.map((s) => chip(s, have)).join("")}</div></div>` : `<p class="hint">No site called “${esc(ob.q)}”. Try “Add a site by URL” below.</p>`;
  } else if (!ob.ints.size) {
    html = `<p class="hint">☝️ Tap a few topics — we'll suggest sources here as you go.</p>`;
  } else {
    html = INTERESTS.filter((i) => ob.ints.has(i.id)).map((i) => {
      const pool = obPool(i), n = ob.expanded.has(i.id) ? pool.length : CHIPS;
      return `<div class="sugg"><h3>${i.emoji} ${i.en} <small>${i.pl}</small></h3><div class="chips-grid">${pool.slice(0, n).map((s) => chip(s, have)).join("")}</div>
        ${pool.length > n ? `<button class="more" data-more="${i.id}">Show ${pool.length - n} more</button>` : ""}${!pool.length ? '<p class="hint">Nothing in the selected languages.</p>' : ""}</div>`;
    }).join("");
  }
  $("#ob-sugg").innerHTML = html; paintHues($("#ob-sugg")); obCount();
}
function obCount() {
  const n = ob.picked.size;
  $("#ob-count").textContent = n ? `${n} source${n > 1 ? "s" : ""} selected` : "Pick a topic to begin";
  $("#ob-start").disabled = !n;
  $("#ob-start").textContent = n ? `Start reading (${n})` : "Start reading";
}
function openOnboard(first = false) {
  $("#app").classList.remove("menu");
  Object.assign(ob, { ints: new Set(), picked: new Map(), auto: new Map(), expanded: new Set(), q: "" });
  $("#ob-search").value = ""; $("#ob-skip").textContent = first ? "Skip for now" : "Close";
  $$("#ob-langs button").forEach((b) => b.classList.toggle("on", ob.langs.has(b.dataset.lang)));
  obTiles(); obSuggest();
  $("#onboard").hidden = false; document.body.classList.add("noscroll"); $("#onboard").scrollTop = 0;
}
function closeOnboard() { $("#onboard").hidden = true; document.body.classList.remove("noscroll"); store.set("onboarded", true); }
function toggleInterest(id) {
  const i = INTERESTS.find((x) => x.id === id);
  if (ob.ints.has(id)) {
    ob.ints.delete(id);
    for (const [u, from] of [...ob.auto]) if (from === id) { ob.auto.delete(u); ob.picked.delete(u); } // drop what this topic suggested, keep manual picks
  } else {
    ob.ints.add(id);
    const have = new Set(feeds.map((f) => f.url));
    obPool(i).filter((s) => !have.has(s.url) && !ob.picked.has(s.url)).slice(0, AUTO_PICK).forEach((s) => { ob.picked.set(s.url, s); ob.auto.set(s.url, id); });
  }
  $(`#ob-tiles [data-int="${id}"]`).classList.toggle("on", ob.ints.has(id));
  obSuggest();
}
function obStart() {
  const added = [...ob.picked.values()].filter((s) => !feeds.some((f) => f.url === s.url)).map(({ url, name, cat, lang }) => ({ url, name, cat, lang }));
  feeds.push(...added); store.set("feeds", feeds);
  closeOnboard(); view = { kind: "all" }; keep.clear(); renderAll();
  if (added.length) { refreshAll(added); toast(`Added ${added.length} source${added.length === 1 ? "" : "s"}`); }
}

/* ---------- add by URL ---------- */
async function discover(input) {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  const text = await fetchText(u);
  try { const p = parseFeed(text); return [{ url: u, name: p.title }]; } catch {}
  const doc = new DOMParser().parseFromString(text, "text/html");
  const found = [...doc.querySelectorAll('link[rel~="alternate"]')]
    .filter((l) => /rss|atom|xml/i.test(l.getAttribute("type") || "") && l.getAttribute("href"))
    .map((l) => ({ url: new URL(l.getAttribute("href"), u).href, name: l.getAttribute("title") || "" }));
  if (found.length) return found;
  for (const path of ["/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/.feed"]) {
    try { const cand = new URL(path, u).href; const p = parseFeed(await fetchText(cand)); return [{ url: cand, name: p.title }]; } catch {}
  }
  return [];
}

/* ---------- OPML ---------- */
function importOPML(text) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) return toast("Invalid OPML");
  let n = 0;
  for (const o of doc.querySelectorAll("outline[xmlUrl]")) {
    const parent = o.parentElement?.localName === "outline" ? o.parentElement.getAttribute("text") || o.parentElement.getAttribute("title") : "";
    const url = o.getAttribute("xmlUrl");
    if (feeds.some((f) => f.url === url)) continue;
    feeds.push({ url, name: o.getAttribute("title") || o.getAttribute("text") || "", cat: parent || "Imported" }); n++;
  }
  store.set("feeds", feeds); renderAll(); toast(`Imported ${n} feeds`);
  if (n) refreshAll();
}
function exportOPML() {
  const cats = {};
  for (const f of feeds) (cats[f.cat || "Other"] ||= []).push(f);
  const body = Object.entries(cats).map(([c, fs]) => `    <outline text="${esc(c)}">\n${fs.map((f) => `      <outline type="rss" text="${esc(f.name)}" title="${esc(f.name)}" xmlUrl="${esc(f.url)}"/>`).join("\n")}\n    </outline>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Kiosk</title></head>\n  <body>\n${body}\n  </body>\n</opml>\n`;
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([xml], { type: "text/xml" })), download: "kiosk.opml" });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- events ---------- */
$("#nav").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setView({ kind: b.dataset.view }); });
$("#feeds").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-rm]"); if (rm) return removeFeed(rm.dataset.rm);
  const f = e.target.closest("[data-feed]"); if (f) return setView({ kind: "feed", feed: f.dataset.feed });
  const c = e.target.closest("[data-cat]"); if (c) setView({ kind: "cat", cat: c.dataset.cat });
});
$("#feeds").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.feed) setView({ kind: "feed", feed: e.target.dataset.feed }); });

$("#feed").addEventListener("click", (e) => {
  const card = e.target.closest(".card"); if (!card) return;
  const act = e.target.closest("[data-act]")?.dataset.act, id = card.dataset.id;
  if (act === "onboard") return openOnboard(false);
  if (act === "reshuffle") return reshuffle();
  if (act === "refresh") return refreshAll();
  if (!id) return;
  if (act === "star") return toggleStar(id);
  if (act === "orig") { const a = articles.find((x) => x.id === id); if (a?.link) window.open(a.link, "_blank", "noopener"); return; }
  if (act === "share") { const a = articles.find((x) => x.id === id); navigator.share({ title: a.title, url: a.link }).catch(() => {}); return; }
  openReader(id);
});

$("#r-close").onclick = () => closeReader();
$("#reader").addEventListener("click", (e) => { if (e.target.id === "reader") closeReader(); });
$("#r-star").onclick = () => readerId && toggleStar(readerId);
$("#r-orig").onclick = () => { const a = articles.find((x) => x.id === readerId); if (a?.link) window.open(a.link, "_blank", "noopener"); };

$("#btn-menu").onclick = () => $("#app").classList.add("menu");
$("#scrim").onclick = () => $("#app").classList.remove("menu");
$("#btn-refresh").onclick = () => refreshAll();
$("#btn-shuffle").onclick = reshuffle;
$("#btn-search").onclick = () => { const r = $("#searchrow"); r.hidden = !r.hidden; if (!r.hidden) $("#search").focus(); else { $("#search").value = ""; query = ""; renderFeed(); } };
let st; $("#search").oninput = (e) => { clearTimeout(st); st = setTimeout(() => { query = e.target.value.trim(); renderFeed(); }, 150); };

// onboarding
$("#btn-add").onclick = () => openOnboard(false);
$("#ob-skip").onclick = closeOnboard;
$("#ob-start").onclick = obStart;
$("#ob-url").onclick = () => { $("#dlg-add").showModal(); };
$("#ob-langs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const l = b.dataset.lang;
  if (ob.langs.has(l)) { if (ob.langs.size === 1) return; ob.langs.delete(l); } else ob.langs.add(l);
  $$("#ob-langs button").forEach((x) => x.classList.toggle("on", ob.langs.has(x.dataset.lang)));
  // drop auto-picks that are no longer in a selected language
  for (const [u] of [...ob.picked]) if (!ob.langs.has(ob.picked.get(u).lang)) { ob.picked.delete(u); ob.auto.delete(u); }
  obSuggest();
});
$("#ob-tiles").addEventListener("click", (e) => { const t = e.target.closest("[data-int]"); if (t) toggleInterest(t.dataset.int); });
$("#ob-search").addEventListener("input", (e) => { ob.q = e.target.value; obSuggest(); });
$("#ob-sugg").addEventListener("click", (e) => {
  const m = e.target.closest("[data-more]"); if (m) { ob.expanded.add(m.dataset.more); return obSuggest(); }
  const c = e.target.closest("[data-src]"); if (!c || c.disabled) return;
  const s = CATALOG.find((x) => x.url === c.dataset.src);
  if (ob.picked.has(s.url)) { ob.picked.delete(s.url); ob.auto.delete(s.url); } else { ob.picked.set(s.url, s); ob.auto.delete(s.url); }
  c.classList.toggle("on", ob.picked.has(s.url)); obCount();
});

// add by URL
$("#url-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#url-msg"); msg.textContent = "Looking for feeds…";
  try {
    const found = await discover($("#url-input").value);
    if (!found.length) { msg.textContent = "No feed found on that site."; return; }
    msg.textContent = "";
    for (const f of found.slice(0, 5)) {
      const row = document.createElement("div"); row.className = "found";
      const span = document.createElement("span"); span.textContent = f.name || f.url;
      const btn = document.createElement("button"); btn.className = "primary"; btn.textContent = feeds.some((x) => x.url === f.url) ? "Added ✓" : "Add";
      btn.onclick = async () => { if (await addFeed({ ...f, cat: "Other" })) { btn.textContent = "Added ✓"; store.set("onboarded", true); } };
      row.append(span, btn); msg.append(row);
    }
  } catch (err) { msg.textContent = `Couldn't load that URL (${err.message}).`; }
});
$("#btn-url").onclick = () => { $("#app").classList.remove("menu"); $("#dlg-add").showModal(); };

$("#btn-import").onclick = () => $("#file-opml").click();
$("#file-opml").onchange = async (e) => { const f = e.target.files[0]; if (f) importOPML(await f.text()); e.target.value = ""; };
$("#btn-export").onclick = exportOPML;
$("#btn-settings").onclick = () => { $("#app").classList.remove("menu"); $("#set-proxy").value = store.get("proxy", ""); $("#set-unread").checked = unreadOnly; $("#set-order").value = order; $("#dlg-settings").showModal(); };
$("#dlg-settings").addEventListener("close", () => {
  store.set("proxy", $("#set-proxy").value.trim()); unreadOnly = $("#set-unread").checked; store.set("unreadOnly", unreadOnly);
  order = $("#set-order").value; store.set("order", order); renderFeed();
});
$("#btn-clear").onclick = async () => {
  if (!confirm("Delete all stored articles (including starred)?")) return;
  await DB.clear(); articles = []; closeReader(); renderAll();
};

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]")) return;
  if (e.target.matches("input")) { if (e.key === "Escape") { e.target.blur(); } return; }
  const k = e.key;
  if (k === "Escape") { if (readerId) closeReader(); else if (!$("#onboard").hidden) closeOnboard(); else $("#app").classList.remove("menu"); return; }
  if (readerId || !$("#onboard").hidden) return;
  if (k === "j" || k === "ArrowDown") { e.preventDefault(); step(1); }
  else if (k === "k" || k === "ArrowUp") { e.preventDefault(); step(-1); }
  else if (k === "Enter") { const id = currentCard()?.dataset.id; if (id) openReader(id); }
  else if (k === "s") { const id = currentCard()?.dataset.id; if (id) toggleStar(id); }
  else if (k === "o") { const a = articles.find((x) => x.id === currentCard()?.dataset.id); if (a?.link) window.open(a.link, "_blank", "noopener"); }
  else if (k === "r") refreshAll();
  else if (k === "/") { e.preventDefault(); $("#searchrow").hidden = false; $("#search").focus(); }
});

/* ---------- boot ---------- */
(async function init() {
  articles = await DB.all().catch(() => []);
  renderAll();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const stale = Date.now() - store.get("lastRefresh", 0) > 15 * 60 * 1000;
  if (stale || !articles.length) refreshAll();
  if (!feeds.length && !store.get("onboarded", false)) openOnboard(true); // first run: personalization screen
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - store.get("lastRefresh", 0) > 15 * 60 * 1000) refreshAll();
  });
})();
