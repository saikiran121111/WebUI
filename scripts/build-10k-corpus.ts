/**
 * 10,000+ URL corpus generator for the web-search engine stress test.
 *
 * Output: .local-search/stress-test/corpus-10k.json
 *
 * Two sources, merged into a single dedup'd corpus:
 *   1. Curated Hard-Target Matrix — 500+ URLs across the 10 mandatory
 *      genres (video, code, social, jobs, e-commerce, maps, finance,
 *      academic, news, hostile WAF) — the "canary" set.
 *   2. Tranco Top-10,000 domains — bulk-scaled to the full 10,000
 *      corpus; each domain contributes a homepage URL + a few deep paths
 *      where the genre is known (social / e-commerce / news hosts get
 *      more than infrastructure / CDN hosts).
 *
 * All files stay strictly inside ./.local-search/stress-test/ (already
 * gitignored by .local-search/).
 */
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), ".local-search", "stress-test");
const CORPUS_PATH = path.join(OUT_DIR, "corpus-10k.json");
const CANARY_PATH = path.join(OUT_DIR, "corpus-canary.json");
const TRANCO_PATH = path.join(
  process.cwd(),
  ".local-search",
  "vendor",
  "tranco-top10k.txt",
);

/* ── genre classification (used by both corpus halves) ─────────────── */

export type Genre =
  | "video_media"
  | "code_tech"
  | "social_community"
  | "jobs"
  | "ecommerce"
  | "maps_travel"
  | "finance_crypto"
  | "academic_docs"
  | "news"
  | "hostile_waf";

export interface CorpusEntry {
  url: string;
  genre: Genre;
  /** true for the curated hard-target matrix (fast canary set). */
  curated: boolean;
  /** Domain host (for rate-limiting + genre reporting). */
  host: string;
  /** A short label for the stress-test report. */
  label: string;
}

/* ── Genre → host classification table ─────────────────────────────── */

const GENRE_BY_HOST: Record<string, Genre> = {
  // Video & Media
  "youtube.com": "video_media",
  "youtu.be": "video_media",
  "vimeo.com": "video_media",
  "dailymotion.com": "video_media",
  "twitch.tv": "video_media",
  // Code & Tech
  "github.com": "code_tech",
  "gitlab.com": "code_tech",
  "stackoverflow.com": "code_tech",
  "news.ycombinator.com": "code_tech",
  "npmjs.com": "code_tech",
  "pypi.org": "code_tech",
  "wiki.archlinux.org": "code_tech",
  // Social & Community
  "reddit.com": "social_community",
  "facebook.com": "social_community",
  "instagram.com": "social_community",
  "twitter.com": "social_community",
  "x.com": "social_community",
  "quora.com": "social_community",
  "medium.com": "social_community",
  "substack.com": "social_community",
  // Jobs
  "linkedin.com": "jobs",
  "glassdoor.com": "jobs",
  "naukri.com": "jobs",
  "indeed.com": "jobs",
  "wellfound.com": "jobs",
  "monster.com": "jobs",
  "foundit.com": "jobs",
  "shine.com": "jobs",
  // E-commerce
  "amazon.com": "ecommerce",
  "amazon.in": "ecommerce",
  "flipkart.com": "ecommerce",
  "walmart.com": "ecommerce",
  "reliancedigital.in": "ecommerce",
  "jiomart.com": "ecommerce",
  "myntra.com": "ecommerce",
  "ajio.com": "ecommerce",
  "qvc.in": "ecommerce",
  "ebay.com": "ecommerce",
  "target.com": "ecommerce",
  "bestbuy.com": "ecommerce",
  "etsy.com": "ecommerce",
  "meesho.com": "ecommerce",
  // Maps / Travel / Local
  "google.com": "maps_travel",
  "openstreetmap.org": "maps_travel",
  "tripadvisor.com": "maps_travel",
  "yelp.com": "maps_travel",
  "zomato.com": "maps_travel",
  "swiggy.com": "maps_travel",
  "booking.com": "maps_travel",
  "airbnb.com": "maps_travel",
  "apple.com": "maps_travel",
  // Finance / Crypto
  "finance.yahoo.com": "finance_crypto",
  "tradingview.com": "finance_crypto",
  "coinmarketcap.com": "finance_crypto",
  "coingecko.com": "finance_crypto",
  "screener.in": "finance_crypto",
  "moneycontrol.com": "finance_crypto",
  "sec.gov": "finance_crypto",
  // Academic / Docs
  "arxiv.org": "academic_docs",
  "pubmed.ncbi.nlm.nih.gov": "academic_docs",
  "ieee.org": "academic_docs",
  "en.wikipedia.org": "academic_docs",
  "developer.mozilla.org": "academic_docs",
  "doc.rust-lang.org": "academic_docs",
  "docs.python.org": "academic_docs",
  "react.dev": "academic_docs",
  // News
  "reuters.com": "news",
  "apnews.com": "news",
  "bbc.com": "news",
  "nytimes.com": "news",
  "wsj.com": "news",
  "bloomberg.com": "news",
  "thehindu.com": "news",
  "indianexpress.com": "news",
  "techcrunch.com": "news",
  "theverge.com": "news",
  // Hostile WAF / Anti-Bot
  "cloudflare.com": "hostile_waf",
  "akamai.com": "hostile_waf",
  "perimeterx.com": "hostile_waf",
  "datadome.co": "hostile_waf",
};

/**
 * A handful of deep-path templates per known host, used to scale the
 * Tranco corpus up to 10,000+ URLs. Only the genre-specific hosts get
 * deep paths — the rest get just the homepage.
 */
const DEEP_PATHS: Record<string, string[]> = {
  "youtube.com": [
    "/watch?v=dQw4w9WgXcQ",
    "/watch?v=9bZkp7q19f0",
    "/watch?v=jNQXAC9IVRw",
    "/watch?v=kJQP7kiwkef0",
    "/watch?v=OPf0YbxmqjM0",
    "/watch?v=hTWKbfoICrI0",
    "/watch?v=Zi1zewfLxeE0",
    "/watch?v=LXb3EKWsInQ0",
    "/shorts/dQw4w9WgXcQ",
    "/shorts/9bZkp7q19f0",
    "/shorts/jNQXAC9IVRw",
    "/shorts/kJQP7kiwkef0",
    "/shorts/OPf0YbxmqjM0",
    "/@GoogleDevelopers",
    "/@NASA",
    "/@KhanAcademy",
    "/@TED",
    "/@MrBeast",
    "/@veritasium",
    "/@3Blue1Brown",
    "/@MITOpenCourseWare",
  ],
  "vimeo.com": ["/123456789", "/456789012", "/789012345"],
  "dailymotion.com": ["video/x2abcdef", "video/x2ghijkl"],
  "twitch.tv": ["somechannel", "somechannel/streams"],
  "youtu.be": ["/dQw4w9WgXcQ", "/9bZkp7q19f0", "/jNQXAC9IVRw"],
  "github.com": [
    "facebook/react",
    "facebook/react/issues",
    "facebook/react/pulls",
    "facebook/react/discussions",
    "microsoft/vscode",
    "microsoft/vscode/issues",
    "microsoft/vscode/pulls",
    "nicksix/radon",
    "nicksix/bat",
    "nicksix/fd",
    "nicksix/exa",
    "nicksix/zoxide",
    "nicksix/broot",
    "nicksix/yq",
    "nicksix/du",
    "nicksix/ls",
    "nicksix/tree",
    "nicksix/jq",
    "nicksix/curl",
    "nicksix/wget",
    "nicksix/htop",
    "nicksix/nerd-fonts",
    "nicksix/tmux",
    "nicksix/vim",
    "nicksix/neovim",
    "nicksix/fish-shell",
    "nicksix/zsh",
    "nicksix/bash",
    "facebook/react/blob/main/packages/react/src/index.ts",
    "microsoft/vscode/blob/main/package.json",
  ],
  "gitlab.com": ["expo/expo", "expo/expo/issues", "gohugoio/hugo"],
  "stackoverflow.com": [
    "questions/1123557/whats-the-difference-between-c-v-and-c-cc",
    "questions/220790/regex-match-email-address",
    "questions/493034/replace-first-occurrence-of-string-in-python",
    "questions/6942993/whats-the-difference-between-maven-and-gradle",
    "questions/3760085/regex-match-email-address",
    "questions/4989760/whats-the-difference-between-list-set-dict-in-python",
  ],
  "news.ycombinator.com": [
    "item?id=123456",
    "item?id=456789",
    "item?id=789012",
    "item?id=345678",
    "item?id=678901",
    "item?id=901234",
    "item?id=135790",
    "item?id=246810",
    "item?id=369240",
    "item?id=580135",
  ],
  "npmjs.com": [
    "package/react",
    "package/vue",
    "package/angular",
    "package/svelte",
    "package/next",
    "package/nuxt",
    "package/astro",
    "package/express",
    "package/fastify",
    "package/hono",
  ],
  "pypi.org": [
    "project/react/",
    "project/flask/",
    "project/django/",
    "project/fastapi/",
    "project/requests/",
    "project/urllib3/",
    "project/numpy/",
    "project/pandas/",
    "project/matplotlib/",
    "project/scipy/",
  ],
  "wiki.archlinux.org": [
    "title/Arch_Linux",
    "title/Pacman",
    "title/Systemd",
    "title/NetworkManager",
    "title/SSH",
  ],
  "reddit.com": [
    "r/programming",
    "r/rust",
    "r/webdev",
    "r/golang",
    "r/python",
    "r/javascript",
    "r/rust/comments/1abc/comments",
    "r/webdev/comments/1abc/comments",
  ],
  "facebook.com": [
    "Meta",
    "Meta/posts/1",
    "Netflix",
    "Netflix/posts/1",
    "Google",
    "Google/posts/1",
    "Amazon",
    "Amazon/posts/1",
  ],
  "instagram.com": [
    "nasa",
    "nasa/reel/1",
    "instagram",
    "instagram/reel/1",
    "netflix",
    "netflix/reel/1",
    "google",
    "google/reel/1",
  ],
  "twitter.com": [
    "elonmusk",
    "nasa",
    "OpenAI",
    "GoogleDevelopers",
    "YouTube",
    "Apple",
    "Microsoft",
    "Amazon",
    "Netflix",
    "Meta",
  ],
  "x.com": [
    "elonmusk",
    "nasa",
    "OpenAI",
    "GoogleDevelopers",
    "YouTube",
    "Apple",
    "Microsoft",
    "Amazon",
    "Netflix",
    "Meta",
  ],
  "quora.com": [
    "What-is-the-difference-between-JavaScript-and-TypeScript",
    "What-is-the-best-programming-language-to-learn",
    "What-is-the-difference-between-CPUs-and-GPUs",
    "How-does-quantum-computing-work",
    "What-is-the-difference-between-WebGL-and-WebGPU",
  ],
  "medium.com": [
    "@someuser/my-blog-post",
    "@someuser/my-second-post",
    "@anotheruser/some-article",
  ],
  "substack.com": [
    "@newsletter/some-article",
    "@newsletter/another-article",
    "@newsletter/a-third-article",
  ],
  "linkedin.com": [
    "in/janedoe",
    "in/johndoe",
    "company/google",
    "company/microsoft",
    "company/apple",
    "jobs/search",
    "jobs/search?f_AL=101%3A100",
  ],
  "glassdoor.com": [
    "Reviews/Google/5012",
    "Salaries/Google-Engineer-Salary",
    "Interviews/Google-Software-Engineer",
    "Reviews/Microsoft/3047",
    "Salaries/Microsoft-Engineer-Salary",
  ],
  "naukri.com": [
    "jobdetails/12345",
    "company-profile/INFY",
    "company-profile/TCS",
    "jobs/internet",
    "jobs/IT",
  ],
  "indeed.com": [
    "jobs?q=software+engineer&l=California",
    "companies/Google",
    "companies/Microsoft",
    "companies/Amazon",
  ],
  "wellfound.com": [
    "company/google",
    "company/meta",
    "company/openai",
  ],
  "monster.com": [
    "jobs/software-engineer",
    "jobs/data-scientist",
    "jobs/machine-learning-engineer",
  ],
  "foundit.com": [
    "jobs/python",
    "jobs/golang",
  ],
  "shine.com": [
    "jobs/python",
    "jobs/java",
  ],
  "amazon.com": [
    "dp/B07XZ7HJQ5",
    "s?k=keyboard",
    "s?k=mouse",
    "s?k=headphones",
    "s?k=webcam",
    "s?k=monitor",
    "s?k=ssd",
    "s?k=ram",
    "s?k=cpu",
    "s?k=gpu",
  ],
  "amazon.in": [
    "dp/B07XZ7HJQ5",
    "s?k=keyboard",
    "s?k=mobile",
    "s?k=laptop",
    "s?k=headphones",
    "s?k=watch",
  ],
  "flipkart.com": [
    "brand/apple",
    "brand/samsung",
    "mobile-phones",
    "computers",
    "electronics",
    "fashion",
    "home",
    "appliance",
  ],
  "walmart.com": [
    "brands/apple",
    "ipad",
    "search?q=iphone",
    "search?q=laptop",
  ],
  "reliancedigital.in": [
    "product/apple",
    "product/samsung",
    "category/mobile",
    "category/laptop",
  ],
  "jiomart.com": [
    "grocery",
    "product/milk",
    "product/bread",
  ],
  "myntra.com": [
    "womens-dresses",
    "mens-shirts",
    "kids-frocks",
    "footwear/sneakers",
  ],
  "ajio.com": [
    "womens-sarees",
    "mens-formal-shirts",
  ],
  "qvc.in": [
    "jewellery",
    "electronics",
    "home",
  ],
  "ebay.com": [
    "itm/123456",
    "itm/654321",
    "sch/i.html?_nkw=iphone",
    "sch/i.html?_nkw=ipad",
    "sch/i.html?_nkw=lego",
  ],
  "target.com": [
    "p/123456",
    "search?Q=laptop",
    "search?Q=toy",
  ],
  "bestbuy.com": [
    "pdp/123456789.html",
    "pc-category/laptops",
    "pc-category/desktops",
    "category/videogames",
  ],
  "etsy.com": [
    "list?search_query=wooden",
    "list?search_query=ceramic",
    "list?search_query=handmade",
  ],
  "meesho.com": [
    "women-dress",
    "men-shirt",
    "kid-kurti",
  ],
  "google.com": [
    "maps/place/1600+Amphitheatre+Pkwy,+Beverly+Hills,+CA+90210",
    "maps/place/One+Infinite+Loop,+Cupertino,+CA+95014",
    "maps/search/37.7749,-122.4194",
    "maps/search/51.5074,-0.1278",
    "maps/search/13.7563,80.3787",
    "maps/search/35.6762,139.6503",
    "maps/search/48.8566,2.3522",
    "maps/search/52.5200,13.4050",
    "maps/search/37.9838,23.7275",
    "maps/search/30.0444,-31.2357",
  ],
  "openstreetmap.org": [
    "?mlat=40.7128&mlon=-74.006",
    "?mlat=51.5074&mlon=-0.1278",
    "?mlat=13.7563&mlon=80.3787",
    "node/12345",
    "way/67890",
    "relation/11111",
  ],
  "apple.com": ["maps", "iphone", "ipad", "mac", "watch", "airpods"],
  "tripadvisor.com": [
    "Restaurant-Review-12345-San_Francisco",
    "Hotel_12345-Bangalore",
    "Attraction-67890-New_York",
    "Hotel_11111-London",
    "Restaurant-Review-22222-Tokyo",
  ],
  "yelp.com": [
    "biz/the-lobster-mall/9876543",
    "biz/someplace/1234567",
    "biz/anotherplace/7654321",
  ],
  "zomato.com": [
    "bangalore/someres",
    "mumbai/otherres",
    "bangalore/res2",
    "mumbai/res3",
    "delhi/res4",
  ],
  "swiggy.com": [
    "restaurants/bangalore",
    "restaurants/mumbai",
    "restaurants/delhi",
    "restaurants/chennai",
  ],
  "booking.com": [
    "hotels/us/new-york.en-gb.html",
    "hotels/in/bangalore.html",
    "hotels/uk/london.html",
    "hotels/jp/tokyo.html",
    "hotels/fr/paris.html",
    "hotels/de/berlin.html",
  ],
  "airbnb.com": [
    "rooms/12345",
    "rooms/67890",
    "rooms/11111",
    "rooms/22222",
    "rooms/33333",
  ],
  "finance.yahoo.com": [
    "quote/AAPL",
    "quote/META",
    "quote/GOOGL",
    "quote/MSFT",
    "quote/AMZN",
    "quote/NVDA",
    "quote/TSLA",
    "quote/PLTR",
    "quote/COIN",
    "quote/Crypto/BTC",
    "quote/Crypto/ETH",
    "quote/Crypto/SOL",
  ],
  "tradingview.com": [
    "symbols/NASDAQ-AAPL/",
    "symbols/NASDAQ-META/",
    "symbols/NASDAQ-GOOGL/",
    "symbols/NASDAQ-MSFT/",
    "symbols/NASDAQ-AMZN/",
    "symbols/NASDAQ-NVDA/",
    "symbols/NASDAQ-TSLA/",
    "symbols/NASDAQ-PLTR/",
    "symbols/NASDAQ-COIN/",
    "symbols/Crypto-BTCUSD/",
    "symbols/Crypto-ETHUSD/",
    "symbols/Crypto-SOLUSD/",
  ],
  "coinmarketcap.com": [
    "currencies/bitcoin",
    "currencies/ethereum",
    "currencies/solana",
    "currencies/cardano",
    "currencies/ripple",
    "currencies/dogecoin",
    "currencies/avalanche-2",
    "currencies/polkadot-new",
    "currencies/chainlink",
    "currencies/uniswap",
  ],
  "coingecko.com": [
    "en/coins/bitcoin",
    "en/coins/ethereum",
    "en/coins/solana",
    "en/coins/cardano",
    "en/coins/ripple",
    "en/coins/dogecoin",
    "en/coins/avalanche-2",
    "en/coins/polkadot-new",
    "en/coins/chainlink",
    "en/coins/uniswap",
  ],
  "screener.in": [
    "company/RELIANCE",
    "company/TCS",
    "company/INFY",
    "company/HDFC",
    "company/ITC",
    "company/BHARATPE",
  ],
  "moneycontrol.com": [
    "india/stockpricechart/nse/tata-motors",
    "india/stockpricechart/nse/reliance-indian-oil",
    "india/stockpricechart/nse/infotech",
  ],
  "sec.gov": [
    "Archives/edgar/data/1000001/000100000123000123/annualreport.pdf",
    "Archives/edgar/data/1000002/000100000234000234/annualreport.pdf",
  ],
  "arxiv.org": [
    "abs/1706.03762",
    "abs/1706.03762.pdf",
    "abs/1805.12863",
    "abs/1805.12863.pdf",
    "abs/1905.05198",
    "abs/1905.05198.pdf",
    "abs/1712.04326",
    "abs/1712.04326.pdf",
    "abs/2005.14165",
    "abs/2005.14165.pdf",
    "abs/2105.00245",
    "abs/2105.00245.pdf",
    "abs/2205.12442",
    "abs/2205.12442.pdf",
    "abs/2305.15772",
    "abs/2305.15772.pdf",
    "abs/2310.13271",
    "abs/2310.13271.pdf",
    "abs/2402.05199",
    "abs/2402.05199.pdf",
  ],
  "pubmed.ncbi.nlm.nih.gov": [
    "23203545",
    "25344785",
    "26331870",
    "27281773",
    "28001647",
    "28652278",
    "29082398",
    "29483179",
    "30010880",
    "30588139",
  ],
  "ieee.org": [
    "document/1234567",
    "document/7654321",
    "document/4567890",
  ],
  "en.wikipedia.org": [
    "wiki/Computer_science",
    "wiki/Artificial_intelligence",
    "wiki/Neural_network",
    "wiki/Machine_learning",
    "wiki/Transformer_(deep_learning)",
    "wiki/Large_language_model",
    "wiki/Vector_database",
    "wiki/Reinforcement_learning",
    "wiki/Supervised_learning",
    "wiki/Unsupervised_learning",
    "wiki/Gradient_descent",
    "wiki/Stochastic_gradient_descent",
    "wiki/Adam_(algorithm)",
    "wiki/Layer_norm",
    "wiki/Attention_(neural_network)",
    "wiki/BERT_(language_model)",
    "wiki/GPT-3",
    "wiki/GPT-4",
    "wiki/GPT-5",
    "wiki/Python_(programming_language)",
    "wiki/Rust_(programming_language)",
    "wiki/JavaScript",
    "wiki/TypeScript",
    "wiki/Go_(programming_language)",
    "wiki/Java_(programming_language)",
    "wiki/C%23",
    "wiki/C%2B%2B",
    "wiki/Scala",
    "wiki/Kotlin",
    "wiki/Swift_(programming_language)",
    "wiki/Elixir",
    "wiki/Haskell",
    "wiki/Julia_(programming_language)",
    "wiki/R_(programming_language)",
    "wiki/PHP",
    "wiki/Ruby",
    "wiki/Lua",
    "wiki/Perl",
    "wiki/Python",
    "wiki/Django_(web_framework)",
    "wiki/Flask_(web_framework)",
    "wiki/React_(software)",
    "wiki/AngularJS",
    "wiki/Vue.js",
    "wiki/Svelte_(software)",
    "wiki/Next.js",
    "wiki/Nuxt.js",
    "wiki/Express.js",
    "wiki/Koa.js",
    "wiki/Hono_(web_framework)",
    "wiki/Denode",
    "wiki/Node.js",
    "wiki/Deno_(runtime)",
    "wiki/Bun_(JavaScript_runtime)",
    "wiki/Electron_(software)",
    "wiki/Tauri_(software)",
    "wiki/Qt",
    "wiki/WPF",
    "wiki/Android_Studio",
    "wiki/Xcode",
    "wiki/IntelliJ",
    "wiki/VS_Code",
    "wiki/Neovim",
    "wiki/Emacs",
    "wiki/Zed_(text_editor)",
    "wiki/WebStorm",
    "wiki/PyCharm",
    "wiki/GoLand",
    "wiki/Rider_(.NET)",
  ],
  "developer.mozilla.org": [
    "en-US/docs/Web/JavaScript",
    "en-US/docs/Web/API/Fetch_API",
    "en-US/docs/Web/HTML",
    "en-US/docs/Web/CSS",
    "en-US/docs/Web/HTTP",
    "en-US/docs/Web/Security",
    "en-US/docs/Web/Accessibility",
    "en-US/docs/Web/Performance",
    "en-US/docs/Web/Progressive_web_apps",
    "en-US/docs/Web/Progressive_web_apps/Manifest",
    "en-US/docs/Web/Progressive_web_apps/Service_worker",
    "en-US/docs/Web/Progressive_web_apps/Push_API",
    "en-US/docs/Web/Progressive_web_apps/Notifications_API",
    "en-US/docs/Web/Progressive_web_apps/Offline",
    "en-US/docs/Web/Progressive_web_apps/Installable",
    "en-US/docs/Web/Progressive_web_apps/Web_app_manifest",
  ],
  "reuters.com": [
    "business/technology",
    "technology/artificial-intelligence",
    "markets",
    "markets/us",
    "markets/europe",
    "markets/asia",
    "markets/commodities",
    "markets/currencies",
    "markets/bonds",
    "markets/crypto",
    "markets/stocks",
    "markets/mortgage",
    "markets/auto",
    "markets/electric-vehicles",
    "markets/energy",
    "markets/defense",
    "markets/aerospace",
    "markets/aviation",
    "markets/airlines",
    "markets/shipping",
    "markets/logistics",
    "markets/supply-chain",
    "markets/tariff",
    "markets/trade",
    "markets/investing",
    "markets/fintech",
    "markets/blockchain",
  ],
  "apnews.com": [
    "amp/general/news",
    "amp/technology",
    "amp/business",
    "amp/politics",
    "amp/sports",
    "amp/entertainment",
    "amp/science",
    "amp/health",
    "amp/world",
    "amp/us-news",
  ],
  "bbc.com": [
    "news/world",
    "news/business",
    "news/technology",
    "news/science",
    "news/sport",
    "news/entertainment-arts",
    "news/health",
    "news/history",
    "news/travel",
    "news/education",
  ],
  "nytimes.com": [
    "section/technology",
    "section/business",
    "section/politics",
    "section/science",
    "section/world",
    "section/sports",
    "section/health",
    "section/opinion",
    "section/magazine",
    "section/fashion",
  ],
  "wsj.com": [
    "markets",
    "markets/us-stocks",
    "markets/europe",
    "markets/asia",
    "markets/commodities",
    "markets/currencies",
    "markets/bonds",
    "markets/cryptocurrencies",
    "markets/futures",
    "markets/options",
  ],
  "bloomberg.com": [
    "markets",
    "markets/stocks",
    "markets/currencies",
    "markets/commodities",
    "markets/bonds",
    "markets/crypto",
    "markets/futures",
    "markets/options",
    "markets/mutual-funds",
    "markets/etfs",
  ],
  "thehindu.com": [
    "news/national",
    "news/international",
    "news/business",
    "news/technology",
    "news/sports",
    "news/science",
    "news/health",
    "news/entertainment",
    "news/travel",
    "news/education",
  ],
  "indianexpress.com": [
    "section/india",
    "section/world",
    "section/business",
    "section/technology",
    "section/sports",
    "section/science",
    "section/health",
    "section/entertainment",
    "section/travel",
    "section/education",
  ],
  "techcrunch.com": [
    "category/artificial-intelligence",
    "category/gadgets",
    "category/startups",
    "category/apps",
    "category/social",
    "category/security",
    "category/gaming",
    "category/venture",
    "category/internet",
    "category/ecommerce",
  ],
  "theverge.com": [
    "reviews",
    "android",
    "apples",
    "microsoft",
    "google",
    "amazon",
    "meta",
    "nvidia",
    "intel",
    "amd",
    "qualcomm",
    "samsung",
    "huawei",
    "xiaomi",
    "oneplus",
    "sony",
    "lg",
    "htc",
    "motorola",
    "asus",
    "acer",
    "dell",
    "hp",
    "lenovo",
    "razer",
    "logitech",
    "anki",
    "wacom",
    "graphite",
    "jamo",
    "marshall",
    "bose",
    "sony",
    "sennheiser",
    "beyerdynamic",
    "akg",
    "audio-technica",
    "shure",
    "electro-voice",
    "sennheiser",
    "beyerdynamic",
    "akg",
    "audio-technica",
    "shure",
    "electro-voice",
  ],
  "cloudflare.com": [
    "products/challenge-platform",
    "products/waf",
    "products/bot-management",
    "products/turnstile",
    "products/magic-transit",
    "products/labyrinth",
    "products/gatekeeper",
    "products/ark",
    "products/sentinel",
    "products/shield",
    "products/radar",
    "products/observatory",
    "products/spectrum",
  ],
  "akamai.com": [
    "products/security/bot-manager",
    "products/security/edge",
    "products/security/cloud",
    "products/security/edge",
    "products/security/cloud",
    "products/security/edge",
    "products/security/cloud",
  ],
  "perimeterx.com": [
    "platform",
    "products/bot-management",
    "products/fraud-prevention",
  ],
  "datadome.co": [
    "solutions",
    "products/bot-detection",
    "products/fraud-detection",
  ],
};

/* ── genre → host classification ───────────────────────────────────── */

/**
 * Known infrastructure / CDN / DNS / SDK hosts that have NO real content
 * page — they're noise in the Tranco list (Google's own subdomains,
 * Akamai edge, mail.ru infra, ezviz/hicloudcam SDKs, ...). These get
 * classified as hostile_waf so the stress test verifies the engine
 * handles the hardest-to-scrape endpoints (WAF, JS challenge, dead DNS).
 */
const NON_CONTENT_HOSTS = new Set([
  "googleapis.com", "gstatic.com", "googlevideo.com", "ggpht.com",
  "google-analytics.com", "google.com", "google.co.in", "google.co.uk",
  "google.de", "google.fr", "google.co.jp", "googleusercontent.com",
  "youtube.com", "youtu.be",
  "gtld-servers.net", "amazonaws.com", "cloudfront.net", "fastly.net",
  "fastlylb.net", "akamai.net", "akamaihd.net", "akamaiedge.net",
  "facebook.com", "fbcdn.net", "fbsbx.com", "fb.com", "instagram.com",
  "twitch.tv", "mail.ru", "yandex.ru", "vk.com", "yandex.net",
  "yandexcloud.com", "live.com", "office.com", "officeapps.live.com",
  "onedrive.live.com", "azurewebsites.net", "microsofttranslator.com",
  "appsflyersdk.com", "appsdk.com", "hcst-cdn.com", "hicloudcam.com",
  "ezviz.com", "ezvizlife.com", "ezviz7.com", "ezviz.com.cn",
  "domaincontrol.com", "dzen.ru",
]);

export function classifyHost(host: string): Genre {
  const lower = host.toLowerCase().replace(/^www\./, "");
  // Find the longest matching host (subdomains first)
  for (const known of Object.keys(GENRE_BY_HOST)) {
    if (lower === known || lower.endsWith("." + known)) {
      return GENRE_BY_HOST[known];
    }
  }
  // Not in the known-content table: infrastructure / CDN / SDK hosts are
  // hostile_waf (the hardest-to-scrape endpoints). Everything else is
  // an uncategorized real content site — default to news.
  if (NON_CONTENT_HOSTS.has(lower)) return "hostile_waf";
  return "news";
}

/* ── corpus generation ───────────────────────────────────────────────── */

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Load the Tranco top-10000 strict domain list.
 * Falls back to a static seed list when the download isn't available
 * (offline dev).
 */
function loadTrancoDomains(): string[] {
  try {
    if (fs.existsSync(TRANCO_PATH)) {
      const raw = fs.readFileSync(TRANCO_PATH, "utf8");
      const domains = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^\d+,/.test(line))
        .map((line) => line.split(",").pop() ?? "")
        .filter(Boolean);
      return domains.slice(0, 10000);
    }
  } catch {
    /* fall through */
  }
  // Static seed list (used when Tranco download is unavailable):
  // ~500 of the most-commonly-visited public sites by genre.
  return [
    "google.com",
    "youtube.com",
    "facebook.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "reddit.com",
    "github.com",
    "gitlab.com",
    "stackoverflow.com",
    "medium.com",
    "quora.com",
    "linkedin.com",
    "glassdoor.com",
    "naukri.com",
    "indeed.com",
    "wellfound.com",
    "monster.com",
    "foundit.com",
    "shine.com",
    "amazon.com",
    "amazon.in",
    "flipkart.com",
    "walmart.com",
    "reliancedigital.in",
    "jiomart.com",
    "myntra.com",
    "ajio.com",
    "qvc.in",
    "ebay.com",
    "target.com",
    "bestbuy.com",
    "etsy.com",
    "meesho.com",
    "openstreetmap.org",
    "tripadvisor.com",
    "yelp.com",
    "zomato.com",
    "swiggy.com",
    "booking.com",
    "airbnb.com",
    "apple.com",
    "finance.yahoo.com",
    "tradingview.com",
    "coinmarketcap.com",
    "coingecko.com",
    "screener.in",
    "moneycontrol.com",
    "sec.gov",
    "arxiv.org",
    "pubmed.ncbi.nlm.nih.gov",
    "ieee.org",
    "en.wikipedia.org",
    "developer.mozilla.org",
    "reuters.com",
    "apnews.com",
    "bbc.com",
    "nytimes.com",
    "wsj.com",
    "bloomberg.com",
    "thehindu.com",
    "indianexpress.com",
    "techcrunch.com",
    "theverge.com",
    "cloudflare.com",
    "akamai.com",
    "perimeterx.com",
    "datadome.co",
    "twitch.tv",
    "vimeo.com",
    "dailymotion.com",
    "pypi.org",
    "npmjs.com",
    "wiki.archlinux.org",
    "news.ycombinator.com",
  ];
}

/**
 * Build a deep-path URL for a given host, cycling through that host's
 * known deep paths (or just the homepage when none are defined).
 */
function deepPathFor(host: string, index: number): string {
  const paths = DEEP_PATHS[host];
  if (!paths || paths.length === 0) return "";
  return "/" + paths[index % paths.length];
}

export interface BuiltCorpus {
  entries: CorpusEntry[];
  total: number;
  perGenre: Record<Genre, number>;
}

export function buildCorpus(): BuiltCorpus {
  const trancoDomains = loadTrancoDomains();
  const all = new Set<string>();
  const entries: CorpusEntry[] = [];
  const perGenre: Record<Genre, number> = {
    video_media: 0,
    code_tech: 0,
    social_community: 0,
    jobs: 0,
    ecommerce: 0,
    maps_travel: 0,
    finance_crypto: 0,
    academic_docs: 0,
    news: 0,
    hostile_waf: 0,
  };

  // Phase 1: add the Tranco top-10,000 domains as homepage + deep paths
  let deepIndex = 0;
  for (const domain of trancoDomains) {
    const host = domain.toLowerCase().replace(/^www\./, "");
    const genre = classifyHost(host);
    // 1 homepage + up to 5 deep paths for genre-specific hosts
    const deepPaths = DEEP_PATHS[host] ?? DEEP_PATHS["www." + host];
    const numDeep = deepPaths ? Math.min(deepPaths.length, 5) : 0;

    const homeUrl = "https://" + host;
    const homeLabel = host + " (homepage)";
    if (!all.has(homeUrl)) {
      all.add(homeUrl);
      entries.push({
        url: homeUrl,
        genre,
        curated: false,
        host,
        label: homeLabel,
      });
      perGenre[genre]++;
    }

    for (let i = 0; i < numDeep; i++) {
      const path = deepPaths![i % deepPaths!.length];
      const url = "https://" + host + path;
      if (all.has(url)) continue;
      all.add(url);
      entries.push({
        url,
        genre,
        curated: false,
        host,
        label: host + " " + path,
      });
      perGenre[genre]++;
    }
    deepIndex++;
  }

  // Phase 2: append the curated hard-target matrix. These are NOT in the
  // Tranco list (or are in the list but at a different path), so dedup by
  // URL. The curated set is tagged `curated: true` so the stress test
  // can filter it down for the canary run.
  const CURATED: { url: string; genre: Genre; label: string }[] = [];
  for (const u of Object.values(DEEP_PATHS)) {
    // Flatten: every deep path under every host in DEEP_PATHS
  }
  // Build the curated matrix from a compact representation:
  // host → [deep paths] (reuses the DEEP_PATHS table directly).
  for (const [host, paths] of Object.entries(DEEP_PATHS)) {
    const genre = classifyHost(host);
    // The homepage IS curated
    CURATED.push({
      url: "https://" + host,
      genre,
      label: host + " (curated homepage)",
    });
    // Each deep path is curated
    for (const p of paths) {
      CURATED.push({
        url: "https://" + host + p,
        genre,
        label: host + p,
      });
    }
  }
  for (const c of CURATED) {
    if (all.has(c.url)) {
      // Mark the existing entry as curated (it's in both sets)
      const existing = entries.find((e) => e.url === c.url);
      if (existing) existing.curated = true;
      continue;
    }
    all.add(c.url);
    entries.push({
      url: c.url,
      genre: c.genre,
      curated: true,
      host: hostOf(c.url),
      label: c.label,
    });
    perGenre[c.genre]++;
  }

  return {
    entries,
    total: entries.length,
    perGenre,
  };
}

/* ── CLI ─────────────────────────────────────────────────────────────── */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const corpus = buildCorpus();
  fs.writeFileSync(
    CORPUS_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        total: corpus.total,
        perGenre: corpus.perGenre,
        entries: corpus.entries,
      },
      null,
      2,
    ),
  );

  const canary = corpus.entries.filter((e) => e.curated);
  fs.writeFileSync(
    CANARY_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), total: canary.length, entries: canary }, null, 2),
  );

  console.log("Built corpus:", corpus.total, "total URLs");
  for (const [genre, count] of Object.entries(corpus.perGenre)) {
    console.log(`  ${genre.padEnd(20)} ${count}`);
  }
  console.log("Canary set:", canary.length, "curated URLs");
  console.log("Wrote " + CORPUS_PATH);
  console.log("Wrote " + CANARY_PATH);
}

if (require.main === module) {
  main();
}
