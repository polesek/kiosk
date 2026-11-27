// Built-in catalog. `starter: true` = subscribed on first run. Dead feeds get pruned by tools/check_feeds.sh.
export const CATALOG = [
  // ---- Polska: wiadomości ----
  { name: "TVN24", url: "https://tvn24.pl/najnowsze.xml", cat: "Polska", lang: "pl", starter: true },
  { name: "Onet Wiadomości", url: "https://wiadomosci.onet.pl/.feed", cat: "Polska", lang: "pl", starter: true },
  { name: "WP Wiadomości", url: "https://wiadomosci.wp.pl/rss.xml", cat: "Polska", lang: "pl", starter: true },
  { name: "Interia Fakty", url: "https://fakty.interia.pl/feed", cat: "Polska", lang: "pl", starter: true },
  { name: "Polsat News", url: "https://www.polsatnews.pl/rss/wszystkie.xml", cat: "Polska", lang: "pl" },
  { name: "RMF24", url: "https://www.rmf24.pl/fakty/feed", cat: "Polska", lang: "pl", starter: true },
  { name: "Rzeczpospolita", url: "https://www.rp.pl/rss_main", cat: "Polska", lang: "pl" },
  { name: "Newsweek Polska", url: "https://www.newsweek.pl/rss.xml", cat: "Polska", lang: "pl" },
  { name: "OKO.press", url: "https://oko.press/feed", cat: "Polska", lang: "pl" },
  { name: "Gazeta.pl Wiadomości", url: "https://wiadomosci.gazeta.pl/pub/rss/wiadomosci.htm", cat: "Polska", lang: "pl" },
  { name: "TVP Info", url: "https://www.tvp.info/tvp.info/rss+xml.php", cat: "Polska", lang: "pl" },
  { name: "Notes from Poland", url: "https://notesfrompoland.com/feed/", cat: "Polska", lang: "en" },
  // ---- Polska: biznes ----
  { name: "Bankier.pl", url: "https://www.bankier.pl/rss/wiadomosci.xml", cat: "Biznes PL", lang: "pl", starter: true },
  { name: "Business Insider PL", url: "https://businessinsider.com.pl/.feed", cat: "Biznes PL", lang: "pl" },
  { name: "Money.pl", url: "https://www.money.pl/rss/rss.xml", cat: "Biznes PL", lang: "pl" },
  // ---- Polska: tech ----
  { name: "Spider's Web", url: "https://www.spidersweb.pl/rss", cat: "Tech PL", lang: "pl", starter: true },
  { name: "Niebezpiecznik", url: "https://niebezpiecznik.pl/feed/", cat: "Tech PL", lang: "pl" },
  { name: "Antyweb", url: "https://antyweb.pl/feed", cat: "Tech PL", lang: "pl" },
  { name: "dobreprogramy", url: "https://www.dobreprogramy.pl/rss/aktualnosci", cat: "Tech PL", lang: "pl" },
  { name: "GRYOnline.pl", url: "https://www.gry-online.pl/rss/news.xml", cat: "Tech PL", lang: "pl" },
  // ---- Polska: sport ----
  { name: "Sport.pl", url: "https://www.sport.pl/pub/rss/sport.xml", cat: "Sport PL", lang: "pl" },
  // ---- World ----
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", cat: "World", lang: "en", starter: true },
  { name: "The Guardian World", url: "https://www.theguardian.com/world/rss", cat: "World", lang: "en" },
  { name: "NPR News", url: "https://feeds.npr.org/1001/rss.xml", cat: "World", lang: "en" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", cat: "World", lang: "en" },
  { name: "DW", url: "https://rss.dw.com/rdf/rss-en-all", cat: "World", lang: "en" },
  { name: "NYT World", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", cat: "World", lang: "en" },
  // ---- Tech & science ----
  { name: "Hacker News", url: "https://hnrss.org/frontpage", cat: "Tech", lang: "en", starter: true },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", cat: "Tech", lang: "en" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml", cat: "Tech", lang: "en" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/", cat: "Tech", lang: "en" },
  { name: "Wired", url: "https://www.wired.com/feed/rss", cat: "Tech", lang: "en" },
  { name: "BBC Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml", cat: "Tech", lang: "en" },
  { name: "ScienceDaily", url: "https://www.sciencedaily.com/rss/all.xml", cat: "Science", lang: "en" },
];
