#!/usr/bin/env python3
"""Build sources.js: harvest candidate news feeds, validate them, keep the live ones.

Inputs
  1. tools/curated.json                      hand-picked feeds (always tried first)
  2. plenaryapp/awesome-rss-feeds (CC0)      OPML lists by country and topic
  3. Wikidata                                websites of newspapers / news sites per country -> feed discovery

A feed is kept only if it parses and has recent articles. Run:  python3 tools/harvest.py
Stdlib only. Polite: identifies itself, modest concurrency, short timeouts.
"""
import json, os, re, ssl, sys, time, xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from html import unescape
from urllib.parse import urljoin, urlparse, quote
from urllib.request import Request, urlopen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "Mozilla/5.0 (compatible; KioskHarvester/1.0; +open-source news reader)"
CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None)
MAX_AGE = timedelta(days=60)
WORKERS = 24

# Wikidata country -> (our category, language, min sitelinks as a notability filter)
COUNTRIES = {
    "Q36":  ("Polska", "pl", 0),
    "Q145": ("United Kingdom", "en", 3),
    "Q30":  ("United States", "en", 5),
}
OPML_COUNTRIES = {"Poland": ("Polska", "pl"), "United Kingdom": ("United Kingdom", "en"), "United States": ("United States", "en")}
SKIP_TOPICS = {"Memes", "Funny"}
RAW = "https://raw.githubusercontent.com/plenaryapp/awesome-rss-feeds/master"


def get(url, timeout=12, limit=2_000_000):
    req = Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, text/xml, text/html, */*"})
    with urlopen(req, timeout=timeout, context=CTX) as r:
        body = r.read(limit)
        return body, r.headers.get("Content-Type", ""), r.geturl()


def decode(body, ctype):
    m = re.search(r"charset=([\w-]+)", ctype, re.I) or re.search(rb'encoding=["\']([\w-]+)', body[:300]) or re.search(rb'<meta[^>]+charset=["\']?([\w-]+)', body[:3000], re.I)
    enc = (m.group(1).decode() if isinstance(m.group(1), bytes) else m.group(1)) if m else "utf-8"
    try:
        return body.decode(enc, "replace")
    except LookupError:
        return body.decode("utf-8", "replace")


def parse_date(s):
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
    except Exception:
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def check_feed(url):
    """Return (title, n_items) if `url` is a live feed with recent articles, else None."""
    try:
        body, ctype, _ = get(url)
    except Exception:
        return None
    text = decode(body, ctype)
    head = text[:2000].lower()
    if "<rss" not in head and "<feed" not in head and "<rdf:rdf" not in head and "<?xml" not in head:
        return None
    n = len(re.findall(r"<(?:item|entry)[\s>]", text))
    if n < 2:
        return None
    dates = [d for d in (parse_date(x) for x in re.findall(r"<(?:pubDate|dc:date|published|updated)[^>]*>([^<]+)<", text)) if d]
    if dates and datetime.now(timezone.utc) - max(dates) > MAX_AGE:
        return None
    m = re.search(r"<title[^>]*>(?:<!\[CDATA\[)?\s*(.*?)\s*(?:\]\]>)?</title>", text, re.S)
    return (unescape(m.group(1)).strip() if m else ""), n


def discover(site):
    """Find feed URLs for a website. Returns (candidate urls, html lang)."""
    cands, lang = [], ""
    try:
        body, ctype, final = get(site)
        html = decode(body, ctype)
        m = re.search(r"<html[^>]+lang=[\"']?([a-zA-Z-]+)", html[:3000])
        lang = m.group(1).lower() if m else ""
        for tag in re.findall(r"<link[^>]+>", html, re.I):
            if re.search(r'rel=["\']?alternate', tag, re.I) and re.search(r'type=["\']?application/(?:rss|atom)\+xml', tag, re.I):
                h = re.search(r'href=["\']([^"\']+)', tag)
                if h and "comment" not in h.group(1).lower():
                    cands.append(urljoin(final, unescape(h.group(1))))
        base = final
    except Exception:
        base = site
    if not cands:
        cands = [urljoin(base, p) for p in ("/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml")]
    return cands[:4], lang


def norm(url):
    p = urlparse(url)
    return re.sub(r"^www\.", "", p.netloc.lower()) + p.path.rstrip("/") + ("?" + p.query if p.query else "")


def site_key(url):
    """Registrable domain, aware of two-level suffixes like co.uk / com.au / com.pl."""
    parts = re.sub(r"^www\.", "", urlparse(url).netloc.lower()).split(".")
    n = 3 if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in ("co", "com", "org", "net", "gov", "ac", "edu") else 2
    return ".".join(parts[-n:])


def clean_name(name, url=None):
    """A usable display name, or "" if `name` is empty / a URL / too long."""
    name = re.sub(r"\s*[-–|:]\s*(RSS|Feed|Najnowsze|Latest).*$", "", unescape(name or ""), flags=re.I).strip()
    return "" if not name or re.match(r"^(https?://|[\w-]+(\.[\w-]+)+$)", name) or len(name) > 60 else name


def nice_name(title, url):
    """Display name from a feed's own <title>: drop taglines after ' - ' / ' | ', fall back to the domain."""
    t = re.split(r"\s+[-–—|:]\s+", unescape(title or "").strip())[0].strip()
    t = re.sub(r"\s*(RSS|Feed|Najnowsze|Latest|News feed)\s*$", "", t, flags=re.I).strip()
    if 2 <= len(t) <= 40 and not t.lower().startswith("http"):
        return t
    return re.sub(r"^www\.", "", urlparse(url).netloc).split(".")[0].capitalize()


# ---------- sources of candidates ----------
def from_curated():
    return [dict(c, origin="curated") for c in json.load(open(os.path.join(ROOT, "tools", "curated.json")))]


def from_sites():
    """Hand-picked site homepages (tools/sites.json); the feed itself is discovered, so URLs can't go stale."""
    return [(e.get("name", ""), e["site"], e["cat"], e["lang"], "sites") for e in json.load(open(os.path.join(ROOT, "tools", "sites.json")))]


def opml_entries(text, cat, lang, origin):
    out = []
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return out
    for o in root.iter("outline"):
        u = o.get("xmlUrl")
        if u:
            out.append(dict(name=o.get("title") or o.get("text") or "", url=u, cat=cat, lang=lang, origin=origin))
    return out


def from_opml():
    out = []
    for fname, (cat, lang) in OPML_COUNTRIES.items():
        try:
            out += opml_entries(get(f"{RAW}/countries/with_category/{quote(fname)}.opml")[0], cat, lang, "opml-country")
        except Exception as e:
            print("  opml fail", fname, e)
    try:
        listing = json.loads(get("https://api.github.com/repos/plenaryapp/awesome-rss-feeds/contents/recommended/with_category")[0])
        for f in listing:
            topic = f["name"].removesuffix(".opml")
            if topic in SKIP_TOPICS:
                continue
            out += opml_entries(get(f["download_url"])[0], topic, "en", "opml-topic")
    except Exception as e:
        print("  topic list fail", e)
    return out


def wikidata_query(q):
    """Run a SPARQL query. Wikidata may allow only ~1 request/minute, so wait and retry on HTTP 429."""
    for attempt in range(4):
        try:
            return json.loads(get("https://query.wikidata.org/sparql?format=json&query=" + quote(q), timeout=70, limit=20_000_000)[0])["results"]["bindings"]
        except Exception as e:
            if "429" in str(e) and attempt < 3:
                print("    rate limited, waiting 65s…"); time.sleep(65); continue
            raise


CACHE = os.path.join(ROOT, "tools", ".cache", "wikidata.json")


def wikidata_sites():
    """[(label, website, cat, lang)] for newspapers / online newspapers / news sites / agencies.
    Cached for 14 days (tools/.cache, git-ignored): Wikidata rate-limits to ~1 query/minute."""
    try:
        if time.time() - os.path.getmtime(CACHE) < 14 * 86400:
            print("  wikidata: using cache"); return [tuple(x) for x in json.load(open(CACHE))]
    except OSError:
        pass
    out = []
    for n, (qid, (cat, lang, minsl)) in enumerate(COUNTRIES.items()):
        if n:
            time.sleep(62)
        q = f"""SELECT DISTINCT ?l ?site WHERE {{
          VALUES ?t {{ wd:Q11032 wd:Q1153191 wd:Q17232649 wd:Q192283 {"wd:Q41298 wd:Q1616075" if lang == "pl" else ""} }}
          ?i wdt:P31 ?t ; wdt:P856 ?site ; wikibase:sitelinks ?sl .
          {{ ?i wdt:P495 wd:{qid} }} UNION {{ ?i wdt:P17 wd:{qid} }}
          FILTER(?sl >= {minsl})
          FILTER NOT EXISTS {{ ?i wdt:P576 [] }}
          ?i rdfs:label ?l . FILTER(lang(?l) = "{ 'pl' if lang == 'pl' else 'en' }")
        }} LIMIT 1500"""
        try:
            rows = wikidata_query(q)
            for r in rows:
                out.append((r["l"]["value"], r["site"]["value"], cat, lang))
            print(f"  wikidata {cat}: {len(rows)} sites")
        except Exception as e:
            print(f"  wikidata {cat} failed: {e}")
    if out:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True); json.dump(out, open(CACHE, "w"), ensure_ascii=False)
    return out


# ---------- pipeline ----------
def validate_direct(c):
    r = check_feed(c["url"])
    if not r:
        return None
    title, n = r
    return dict(c, name=clean_name(c["name"]) or nice_name(title, c["url"]), items=n)


def validate_site(label, site, cat, lang, origin="wikidata"):
    cands, hl = discover(site)
    if hl and not hl.startswith(lang):  # e.g. a French-language Canadian paper
        return None
    for u in cands:
        r = check_feed(u)
        if r:
            return dict(name=clean_name(label) or nice_name(r[0], u), url=u, cat=cat, lang=lang, origin=origin, items=r[1])
    return None


def main():
    t0 = time.time()
    print("collecting candidates…")
    direct = from_curated() + from_opml()
    sites = from_sites() + wikidata_sites()
    print(f"  {len(direct)} direct feeds, {len(sites)} websites to probe")

    kept, seen = [], set()
    with ThreadPoolExecutor(WORKERS) as ex:
        futs = [ex.submit(validate_direct, c) for c in direct] + [ex.submit(validate_site, *s) for s in sites]
        for i, f in enumerate(as_completed(futs), 1):
            try:
                r = f.result()
            except Exception:
                r = None
            if r:
                kept.append(r)
            if i % 200 == 0:
                print(f"  …{i}/{len(futs)} checked, {len(kept)} live")

    # de-duplicate: curated wins, then OPML, then wikidata; one feed per URL and per site+category
    prio = {"curated": 0, "sites": 0, "opml-country": 1, "opml-topic": 1, "wikidata": 2}
    kept.sort(key=lambda r: prio[r["origin"]])
    final, urls, sitecat = [], set(), set()
    for r in kept:
        k = norm(r["url"]); host = site_key(r["url"]) + "|" + r["cat"]
        if k in urls or host in sitecat:
            continue
        urls.add(k); sitecat.add(host); final.append(r)

    cat_rank = {"Polska": 0, "Biznes PL": 1, "Tech PL": 2, "Sport PL": 3, "World": 4, "Tech": 5, "Science": 6}
    top = lambda r: 0 if r["origin"] in ("curated", "sites") else 1   # well-known first, then the long tail
    final.sort(key=lambda r: (r["lang"] != "pl", cat_rank.get(r["cat"], 50), r["cat"], top(r), r["name"].lower()))

    lines = [json.dumps({k: r[k] for k in ("name", "url", "cat", "lang")}, ensure_ascii=False) for r in final]
    header = ("// GENERATED by tools/harvest.py - do not edit by hand.\n"
              "// To add a source permanently, put it in tools/curated.json and re-run the harvester.\n"
              f"// {len(final)} live sources, checked {datetime.now(timezone.utc):%Y-%m-%d}.\n")
    open(os.path.join(ROOT, "sources.js"), "w").write(header + "export const CATALOG = [\n  " + ",\n  ".join(lines) + ",\n];\n")

    by = {}
    for r in final:
        by.setdefault((r["lang"], r["cat"]), 0); by[(r["lang"], r["cat"])] += 1
    print(f"\ndone in {time.time()-t0:.0f}s: {len(final)} sources ({sum(1 for r in final if r['lang']=='pl')} PL, {sum(1 for r in final if r['lang']=='en')} EN)")
    for (lang, cat), n in sorted(by.items(), key=lambda x: (x[0][0] != "pl", -x[1])):
        print(f"  {lang} {cat}: {n}")


if __name__ == "__main__":
    main()
