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

/* ---------- rendering ---------- */
const feedOf = (url) => feeds.find((f) => f.url === url);
function filtered() {
  let list = articles;
  if (view.kind === "unread") list = list.filter((a) => !a.read);
  else if (view.kind === "star") list = list.filter((a) => a.star);
  else if (view.kind === "feed") list = list.filter((a) => a.feed === view.feed);
  else if (view.kind === "cat") { const urls = new Set(feeds.filter((f) => (f.cat || "Other") === view.cat).map((f) => f.url)); list = list.filter((a) => urls.has(a.feed)); }
  if (unreadOnly && !["unread", "star"].includes(view.kind)) list = list.filter((a) => !a.read || a.id === selectedId);
  if (query) { const q = query.toLowerCase(); list = list.filter((a) => a.title.toLowerCase().includes(q) || a.snippet.toLowerCase().includes(q)); }
  list = [...list].sort((a, b) => b.date - a.date);
  return order === "shuffle" && !query && view.kind !== "star" ? mix(list) : list;
}

// Stable pseudo-random key in [0,1) for an id + the current seed, so the order doesn't jump
// when articles are marked read or the list re-renders. Changing `seed` reshuffles.
function rand(str) {
  let h = 2166136261 ^ Math.floor(seed * 4294967296);
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; // avalanche
  return (h >>> 0) / 4294967296;
}
// Shuffle each source's articles, then deal them out in rounds: every round takes one article from
// each source that still has some, with the sources in a fresh random order each time. This keeps one
// busy outlet from filling the list without the result looking like a fixed rotation.
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
  }).join("");
}

function renderList() {
  const list = filtered();
  const page = list.slice(0, shown);
  visibleIds = page.map((a) => a.id);
  $("#items").innerHTML = page.map((a) => {
    const f = feedOf(a.feed);
    return `<li class="item ${a.read ? "read" : "unread"} ${a.id === selectedId ? "sel" : ""}" data-id="${esc(a.id)}">
      <div class="txt"><div class="meta"><span class="src">${esc(f?.name || "")}</span><span>· ${ago(a.date)}</span>${a.star ? '<span class="star">★</span>' : ""}</div>
      <div class="ttl">${esc(a.title)}</div><div class="snip">${esc(a.snippet)}</div></div>
      ${a.img ? `<img src="${esc(a.img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</li>`;
  }).join("") + (list.length > shown ? `<li class="more"><button id="more">Show ${Math.min(PAGE, list.length - shown)} more <span class="muted">(${list.length - shown} left)</span></button></li>` : "");
  const empty = $("#empty");
  empty.hidden = list.length > 0;
  if (!list.length) {
    if (!feeds.length) empty.innerHTML = `<p>Nothing here yet.</p><button id="empty-add" class="primary">Add news sources</button>`;
    else empty.textContent = !articles.length ? "Loading… pull in articles with Refresh (r)." : query ? "No matches." : "Nothing here.";
  }
  $("#btn-unread").setAttribute("aria-pressed", String(unreadOnly));
  const t = view.kind === "feed" ? feedOf(view.feed)?.name : view.kind === "cat" ? view.cat : { all: "All", unread: "Unread", star: "Starred" }[view.kind];
  $("#title").textContent = t || "All";
  $("#btn-shuffle").classList.toggle("on", order === "shuffle");
}

function renderReader() {
  const a = articles.find((x) => x.id === selectedId);
  $("#reader-empty").hidden = !!a; $("#reader-body").hidden = !a;
  if (!a) return;
  const f = feedOf(a.feed);
  const showHero = a.img && !a.html.includes(a.img);
  const thin = textOf(a.html).length < 400;
  $("#reader-body").innerHTML = `
    <div class="r-bar">
      <button id="r-back">← Back</button>
      <button id="r-star">${a.star ? "★ Starred" : "☆ Star"}</button>
      <button id="r-read">${a.read ? "Mark unread" : "Mark read"}</button>
      ${navigator.share ? '<button id="r-share">Share</button>' : ""}
      ${a.link ? `<a class="${thin ? "primary" : ""}" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">Open original ↗</a>` : ""}
    </div>
    <h2>${esc(a.title)}</h2>
    <div class="r-meta">${esc(f?.name || "")} · ${new Date(a.date).toLocaleString()}</div>
    ${showHero ? `<img class="r-hero" src="${esc(a.img)}" alt="" referrerpolicy="no-referrer">` : ""}
    <div class="r-content">${a.html}</div>
    ${thin && a.link ? `<p class="r-more muted">This feed only provides a short summary.</p>` : ""}`;
  $("#reader").scrollTop = 0;
}

function renderAll() { renderSide(); renderList(); }

/* ---------- actions ---------- */
function setView(v) {
  view = v; selectedId = null; shown = PAGE;
  $("#app").classList.remove("menu", "reading");
  renderAll(); renderReader(); $("#items").scrollTop = 0;
}
async function patch(a, props) { Object.assign(a, props); await DB.put(a); }
function open(id) {
  const a = articles.find((x) => x.id === id); if (!a) return;
  selectedId = id;
  if (!a.read) patch(a, { read: true });
  $("#app").classList.add("reading");
  renderSide(); renderList(); renderReader();
  $(`.item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
}
const current = () => articles.find((x) => x.id === selectedId);
function move(d) {
  if (!visibleIds.length) return;
  const i = visibleIds.indexOf(selectedId);
  open(visibleIds[Math.max(0, Math.min(visibleIds.length - 1, i < 0 ? 0 : i + d))]);
}
async function toggle(prop) {
  const a = current(); if (!a) return;
  await patch(a, { [prop]: !a[prop] }); renderSide(); renderList(); renderReader();
}
async function addFeed(f) {
  if (feeds.some((x) => x.url === f.url)) return false;
  feeds.push({ url: f.url, name: f.name || "", cat: f.cat || "Other", lang: f.lang });
  store.set("feeds", feeds); renderSide();
  refreshFeed(feeds[feeds.length - 1]).catch((e) => { feeds[feeds.length - 1].error = String(e.message || e); }).finally(() => { store.set("feeds", feeds); renderAll(); });
  return true;
}
async function removeFeed(url) {
  const f = feedOf(url);
  if (!f || !confirm(`Remove “${f.name || url}” and its articles?`)) return;
  feeds = feeds.filter((x) => x.url !== url); store.set("feeds", feeds);
  const ids = articles.filter((a) => a.feed === url && !a.star).map((a) => a.id);
  await DB.del(ids); const gone = new Set(ids); articles = articles.filter((a) => !gone.has(a.id));
  if (view.feed === url) view = { kind: "all" };
  renderAll(); renderReader();
}

/* ---------- add dialog ---------- */
const picked = new Set();          // catalog URLs ticked in the picker
const langSel = new Set(["pl", "en"]);
let catFilter = "";
function renderCatalog() {
  const have = new Set(feeds.map((f) => f.url));
  const q = $("#cat-search").value.trim().toLowerCase();
  const pool = CATALOG.filter((s) => langSel.has(s.lang));
  const counts = {};
  for (const s of pool) counts[s.cat] = (counts[s.cat] || 0) + 1;
  if (catFilter && !counts[catFilter]) catFilter = "";
  $("#cat-chips").innerHTML = `<button data-cat="" class="${catFilter ? "" : "on"}">All <small>${pool.length}</small></button>` +
    Object.entries(counts).map(([c, n]) => `<button data-cat="${esc(c)}" class="${catFilter === c ? "on" : ""}">${esc(c)} <small>${n}</small></button>`).join("");
  const shown = pool.filter((s) => (!catFilter || s.cat === catFilter) && (!q || `${s.name} ${s.cat} ${s.url}`.toLowerCase().includes(q)));
  const groups = {};
  for (const s of shown) (groups[s.cat] ||= []).push(s);
  $("#catalog").innerHTML = Object.entries(groups).map(([c, ss]) => {
    const free = ss.filter((x) => !have.has(x.url));
    const all = free.length && free.every((x) => picked.has(x.url));
    return `<div class="cat-h"><span>${esc(c)}</span>${free.length ? `<button data-all="${esc(c)}">${all ? "Clear" : "Select all"}</button>` : ""}</div>` +
      ss.map((x) => have.has(x.url)
        ? `<div class="cat-item added"><span class="nm">${esc(x.name)}</span><span class="muted">Added ✓</span></div>`
        : `<label class="cat-item"><input type="checkbox" data-pick="${esc(x.url)}" ${picked.has(x.url) ? "checked" : ""}><span class="nm">${esc(x.name)}</span><small class="muted">${x.lang.toUpperCase()}</small></label>`).join("");
  }).join("") || `<p class="muted pad">No sources match.</p>`;
  updatePickBar();
}
function updatePickBar() {
  $("#pick-count").textContent = picked.size ? `${picked.size} selected` : "Tick the sources you want";
  $("#btn-add-picked").disabled = !picked.size;
  $("#btn-add-picked").textContent = picked.size ? `Add ${picked.size} source${picked.size > 1 ? "s" : ""}` : "Add";
}
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
$("#items").addEventListener("click", (e) => {
  if (e.target.closest("#more")) { shown += PAGE; return renderList(); }
  const li = e.target.closest(".item"); if (li) open(li.dataset.id);
});
$("#btn-shuffle").onclick = () => {
  if (order !== "shuffle") { order = "shuffle"; store.set("order", order); }
  seed = Math.random(); shown = PAGE; selectedId = null; renderList(); renderReader(); $("#items").scrollTop = 0;
};
$("#reader").addEventListener("click", (e) => {
  const id = e.target.id;
  if (id === "r-back") { $("#app").classList.remove("reading"); }
  else if (id === "r-star") toggle("star");
  else if (id === "r-read") toggle("read");
  else if (id === "r-share") { const a = current(); navigator.share({ title: a.title, url: a.link }).catch(() => {}); }
});
$("#btn-menu").onclick = () => $("#app").classList.add("menu");
$("#scrim").onclick = () => $("#app").classList.remove("menu");
$("#btn-refresh").onclick = () => refreshAll();
$("#btn-unread").onclick = () => { unreadOnly = !unreadOnly; store.set("unreadOnly", unreadOnly); renderList(); };
let st; $("#search").oninput = (e) => { clearTimeout(st); st = setTimeout(() => { query = e.target.value.trim(); renderList(); }, 120); };

function openAdd(first = false) {
  $("#app").classList.remove("menu");
  $("#dlg-add").classList.toggle("first", first === true);
  $("#add-title").textContent = first === true ? "What do you want to read?" : "Add sources";
  $("#add-intro").hidden = first !== true;
  renderCatalog(); $("#dlg-add").showModal();
}
$("#btn-add").onclick = () => openAdd();
$("#empty").addEventListener("click", (e) => { if (e.target.id === "empty-add") openAdd(); });
$("#dlg-add").addEventListener("close", () => store.set("onboarded", true));
$("#dlg-add .tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $$("#dlg-add .tabs button").forEach((x) => x.classList.toggle("on", x === b));
  $("#tab-catalog").hidden = b.dataset.tab !== "catalog"; $("#tab-url").hidden = b.dataset.tab !== "url";
});
$("#lang-chips").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const l = b.dataset.lang;
  if (langSel.has(l)) { if (langSel.size === 1) return; langSel.delete(l); } else langSel.add(l);
  $$("#lang-chips button").forEach((x) => x.classList.toggle("on", langSel.has(x.dataset.lang)));
  renderCatalog();
});
$("#cat-chips").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { catFilter = b.dataset.cat; renderCatalog(); } });
$("#cat-search").addEventListener("input", () => renderCatalog());
$("#catalog").addEventListener("change", (e) => {
  const u = e.target.dataset.pick; if (!u) return;
  e.target.checked ? picked.add(u) : picked.delete(u); updatePickBar();
});
$("#catalog").addEventListener("click", (e) => {
  const b = e.target.closest("[data-all]"); if (!b) return;
  const have = new Set(feeds.map((f) => f.url));
  const q = $("#cat-search").value.trim().toLowerCase();
  const group = CATALOG.filter((x) => x.cat === b.dataset.all && langSel.has(x.lang) && !have.has(x.url) && (!q || `${x.name} ${x.cat} ${x.url}`.toLowerCase().includes(q)));
  const all = group.every((x) => picked.has(x.url));
  group.forEach((x) => (all ? picked.delete(x.url) : picked.add(x.url)));
  renderCatalog();
});
$("#btn-add-picked").onclick = () => {
  const chosen = CATALOG.filter((x) => picked.has(x.url) && !feeds.some((f) => f.url === x.url));
  const added = chosen.map(({ url, name, cat, lang }) => ({ url, name, cat, lang }));
  feeds.push(...added); store.set("feeds", feeds); picked.clear();
  $("#dlg-add").close(); renderAll(); refreshAll(added);
  toast(`Added ${added.length} source${added.length === 1 ? "" : "s"}`);
};
$("#url-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("#url-msg"); msg.textContent = "Looking for feeds…"; msg.replaceChildren(msg.firstChild);
  try {
    const found = await discover($("#url-input").value);
    if (!found.length) { msg.textContent = "No feed found on that site."; return; }
    msg.textContent = "";
    for (const f of found.slice(0, 5)) {
      const row = document.createElement("div"); row.className = "found";
      const span = document.createElement("span"); span.textContent = f.name || f.url;
      const btn = document.createElement("button"); btn.className = "primary"; btn.textContent = feeds.some((x) => x.url === f.url) ? "Added ✓" : "Add";
      btn.onclick = async () => { if (await addFeed({ ...f, cat: "Other" })) btn.textContent = "Added ✓"; };
      row.append(span, btn); msg.append(row);
    }
  } catch (err) { msg.textContent = `Couldn't load that URL (${err.message}).`; }
});

$("#btn-import").onclick = () => $("#file-opml").click();
$("#file-opml").onchange = async (e) => { const f = e.target.files[0]; if (f) importOPML(await f.text()); e.target.value = ""; };
$("#btn-export").onclick = exportOPML;
$("#btn-settings").onclick = () => { $("#app").classList.remove("menu"); $("#set-proxy").value = store.get("proxy", ""); $("#set-unread").checked = unreadOnly; $("#set-order").value = order; $("#dlg-settings").showModal(); };
$("#dlg-settings").addEventListener("close", () => {
  store.set("proxy", $("#set-proxy").value.trim()); unreadOnly = $("#set-unread").checked; store.set("unreadOnly", unreadOnly);
  order = $("#set-order").value; store.set("order", order); shown = PAGE; renderList();
});
$("#btn-clear").onclick = async () => {
  if (!confirm("Delete all stored articles (including starred)?")) return;
  await DB.clear(); articles = []; selectedId = null; renderAll(); renderReader();
};

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]")) return;
  if (e.target.matches("input")) { if (e.key === "Escape") e.target.blur(); return; }
  const k = e.key;
  if (k === "j") move(1); else if (k === "k") move(-1);
  else if (k === "s") toggle("star"); else if (k === "m") toggle("read");
  else if (k === "o") { const a = current(); if (a?.link) window.open(a.link, "_blank", "noopener"); }
  else if (k === "r") refreshAll();
  else if (k === "/") { e.preventDefault(); $("#search").focus(); }
  else if (k === "Escape") $("#app").classList.remove("reading", "menu");
});

/* ---------- boot ---------- */
(async function init() {
  articles = await DB.all().catch(() => []);
  renderAll(); renderReader();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const stale = Date.now() - store.get("lastRefresh", 0) > 15 * 60 * 1000;
  if (stale || !articles.length) refreshAll();
  if (!feeds.length && !store.get("onboarded", false)) openAdd(true); // first run: personalization screen
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - store.get("lastRefresh", 0) > 15 * 60 * 1000) refreshAll();
  });
})();
