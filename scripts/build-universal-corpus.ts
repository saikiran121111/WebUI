/**
 * Universal 25-genre × 12-archetype 10,000+ URL corpus generator.
 *
 * Output: .local-search/stress-test/universal-corpus.json
 *
 * Two sources, merged into a single dedup'd corpus:
 *   1. Curated Universal Matrix — ~750 URLs across 25 genres and 12
 *      structural archetypes (the "canary" set).
 *   2. Tranco Top-10,000 domains — bulk-scaled to the full 10,000+
 *      corpus; each domain contributes a homepage URL.
 *
 * All files stay strictly inside ./.local-search/stress-test/ (already
 * gitignored by .local-search/).
 */
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), ".local-search", "stress-test");
const CORPUS_PATH = path.join(OUT_DIR, "universal-corpus.json");
const CANARY_PATH = path.join(OUT_DIR, "universal-canary.json");
const TRANCO_PATH = path.join(
  process.cwd(),
  ".local-search",
  "vendor",
  "tranco-top10k.txt",
);

/* ── universal taxonomy ───────────────────────────────────────────────── */

/** 25 universal internet genres (complete web taxonomy). */
export type Genre =
  | "personal_portfolio"
  | "saas_product"
  | "software_docs"
  | "open_source"
  | "tech_community"
  | "ecommerce"
  | "hardware_review"
  | "jobs_career"
  | "video_podcast"
  | "social_creator"
  | "maps_local"
  | "travel_hospitality"
  | "finance_equities"
  | "crypto_web3"
  | "academic_research"
  | "news"
  | "government_legal"
  | "healthcare"
  | "education_mooc"
  | "real_estate"
  | "automotive"
  | "gaming_wiki"
  | "recipes_food"
  | "reference_encyclopedia"
  | "hostile_edge"
  | "uncategorized";

/** 12 structural archetypes (the page's rendering technology). */
export type Archetype =
  | "next_rsc"
  | "nuxt_vue_remix_sveltekit_astro_ssr"
  | "webflow_framer_wix_squarespace_carrd"
  | "docusaurus_mintlify_vitepress_gitbook_rtd_docs"
  | "shopify_woocommerce_magento_ecom"
  | "wordpress_ghost_substack_medium_cms"
  | "complex_tables_saaS_pricing_matrices"
  | "discourse_reddit_stackexchange_forum"
  | "pdf_arxiv_csv_markdown"
  | "video_audio_page"
  | "auth_walled_social"
  | "heavy_waf"
  | "legacy_non_utf8";

export interface UniversalEntry {
  url: string;
  genre: Genre;
  /** The page's structural archetype (12 values). */
  archetype: Archetype;
  /** true for the curated universal matrix (fast canary set). */
  curated: boolean;
  /** Domain host (for rate-limiting + genre reporting). */
  host: string;
  /** A short label for the stress-test report. */
  label: string;
}

/* ── host → genre + archetype classification tables ──────────────────── */

const GENRE_BY_HOST: Record<string, Genre> = {
  // Personal portfolios / indie dev
  "vercel.app": "personal_portfolio",
  "netlify.app": "personal_portfolio",
  "github.io": "personal_portfolio",
  // SaaS product pages
  "stripe.com": "saas_product",
  "vercel.com": "saas_product",
  "netlify.com": "saas_product",
  "notion.so": "saas_product",
  "linear.app": "saas_product",
  "figma.com": "saas_product",
  "amplitude.com": "saas_product",
  "mixpanel.com": "saas_product",
  "datadog.com": "saas_product",
  "sentry.io": "saas_product",
  "honeybadger.io": "saas_product",
  "rollbar.com": "saas_product",
  "cloudflare.com": "saas_product",
  "fastly.com": "saas_product",
  "akamai.com": "saas_product",
  // Software docs
  "docs.rs": "software_docs",
  "readthedocs.io": "software_docs",
  "mintlify.com": "software_docs",
  "docusaurus.io": "software_docs",
  "vitepress.dev": "software_docs",
  "gitbook.io": "software_docs",
  "developer.mozilla.org": "software_docs",
  "react.dev": "software_docs",
  "nuxt.com": "software_docs",
  "svelte.dev": "software_docs",
  "astro.build": "software_docs",
  "nodejs.org": "software_docs",
  "deno.com": "software_docs",
  "bun.sh": "software_docs",
  "doc.rust-lang.org": "software_docs",
  "docs.python.org": "software_docs",
  "go.dev": "software_docs",
  "kotlinlang.org": "software_docs",
  "golang.org": "software_docs",
  // Open source
  "github.com": "open_source",
  "gitlab.com": "open_source",
  "codeberg.org": "open_source",
  "npmjs.com": "open_source",
  "pypi.org": "open_source",
  "crates.io": "open_source",
  "huggingface.co": "open_source",
  "hub.docker.com": "open_source",
  "news.ycombinator.com": "tech_community",
  "lobste.rs": "tech_community",
  "dev.to": "tech_community",
  "hashnode.dev": "tech_community",
  "stackoverflow.com": "tech_community",
  "reddit.com": "tech_community",
  "discuss.pytorch.org": "tech_community",
  "discourse.org": "tech_community",
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
  // Hardware reviews
  "gsmarena.com": "hardware_review",
  "rtings.com": "hardware_review",
  "tomshardware.com": "hardware_review",
  "anandtech.com": "hardware_review",
  "wirecutter.com": "hardware_review",
  "pcpartpicker.com": "hardware_review",
  // Jobs / career
  "linkedin.com": "jobs_career",
  "naukri.com": "jobs_career",
  "glassdoor.com": "jobs_career",
  "indeed.com": "jobs_career",
  "wellfound.com": "jobs_career",
  "levels.fyi": "jobs_career",
  "ambitionbox.com": "jobs_career",
  "ycombinator.com": "jobs_career",
  "crunchbase.com": "jobs_career",
  "monster.com": "jobs_career",
  "foundit.com": "jobs_career",
  "shine.com": "jobs_career",
  // Video / podcast
  "youtube.com": "video_podcast",
  "youtu.be": "video_podcast",
  "vimeo.com": "video_podcast",
  "twitch.tv": "video_podcast",
  "open.spotify.com": "video_podcast",
  "podcasts.apple.com": "video_podcast",
  "ted.com": "video_podcast",
  "dailymotion.com": "video_podcast",
  // Social / creator
  "instagram.com": "social_creator",
  "facebook.com": "social_creator",
  "twitter.com": "social_creator",
  "x.com": "social_creator",
  "threads.net": "social_creator",
  "pinterest.com": "social_creator",
  "quora.com": "social_creator",
  "substack.com": "social_creator",
  "patreon.com": "social_creator",
  "medium.com": "social_creator",
  // Maps / local
  "openstreetmap.org": "maps_local",
  "yelp.com": "maps_local",
  "tripadvisor.com": "maps_local",
  "zomato.com": "maps_local",
  "swiggy.com": "maps_local",
  "justdial.com": "maps_local",
  // Travel
  "booking.com": "travel_hospitality",
  "airbnb.com": "travel_hospitality",
  "makemytrip.com": "travel_hospitality",
  "skyscanner.com": "travel_hospitality",
  "agoda.com": "travel_hospitality",
  "rome2rio.com": "travel_hospitality",
  // Finance / equities
  "finance.yahoo.com": "finance_equities",
  "screener.in": "finance_equities",
  "moneycontrol.com": "finance_equities",
  "tradingview.com": "finance_equities",
  "sec.gov": "finance_equities",
  "morningstar.com": "finance_equities",
  // Crypto / web3
  "coingecko.com": "crypto_web3",
  "coinmarketcap.com": "crypto_web3",
  "etherscan.io": "crypto_web3",
  "defillama.com": "crypto_web3",
  "coinbase.com": "crypto_web3",
  // Academic
  "arxiv.org": "academic_research",
  "pubmed.ncbi.nlm.nih.gov": "academic_research",
  "api.semanticscholar.org": "academic_research",
  "ieeexplore.ieee.org": "academic_research",
  "nature.com": "academic_research",
  "scholar.google.com": "academic_research",
  "ssrn.com": "academic_research",
  "en.wikipedia.org": "reference_encyclopedia",
  "en.wiktionary.org": "reference_encyclopedia",
  "britannica.com": "reference_encyclopedia",
  "plato.stanford.edu": "reference_encyclopedia",
  "archive.org": "reference_encyclopedia",
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
  "arstechnica.com": "news",
  "theverge.com": "news",
  // Government / legal
  "whitehouse.gov": "government_legal",
  "gov.uk": "government_legal",
  "india.gov.in": "government_legal",
  "nic.in": "government_legal",
  "courtslist.com": "government_legal",
  "patents.google.com": "government_legal",
  "legislate.gov": "government_legal",
  // Healthcare
  "mayoclinic.org": "healthcare",
  "webmd.com": "healthcare",
  "medlineplus.gov": "healthcare",
  "nih.gov": "healthcare",
  "examine.com": "healthcare",
  "clinicaltrials.gov": "healthcare",
  // Education / MOOC
  "mit.edu": "education_mooc",
  "ocw.mit.edu": "education_mooc",
  "coursera.org": "education_mooc",
  "edx.org": "education_mooc",
  "khanacademy.org": "education_mooc",
  "leetcode.com": "education_mooc",
  "neetcode.net": "education_mooc",
  // Real estate
  "zillow.com": "real_estate",
  "redfin.com": "real_estate",
  "99acres.com": "real_estate",
  "magicbricks.com": "real_estate",
  "nobroker.in": "real_estate",
  // Automotive
  "bikewale.com": "automotive",
  "cardekho.com": "automotive",
  "team-bhp.com": "automotive",
  "revzilla.com": "automotive",
  // Gaming / wiki
  "fextralife.com": "gaming_wiki",
  "fandom.com": "gaming_wiki",
  "ign.com": "gaming_wiki",
  "store.steampowered.com": "gaming_wiki",
  "imdb.com": "gaming_wiki",
  "letterboxd.com": "gaming_wiki",
  "metacritic.com": "gaming_wiki",
  // Recipes / food
  "seriouseats.com": "recipes_food",
  "allrecipes.com": "recipes_food",
  "cooking.nytimes.com": "recipes_food",
  "downshiftfoodblog.com": "recipes_food",
  // Hostile / edge-case
  "perimeterx.com": "hostile_edge",
  "datadome.co": "hostile_edge",
};

/**
 * Classify a URL's structural archetype from its host + URL pattern.
 * This is a heuristic: it's not meant to be perfect, just to give the
 * stress test a reasonable archetype label so the report can break
 * results down by archetype.
 */
export function classifyArchetype(url: string, host: string): Archetype {
  const lower = url.toLowerCase();
  // PDF / CSV / JSON / Markdown
  const ext = lower.split(/[?#]/)[0].split(".").pop() ?? "";
  if (ext === "pdf") return "pdf_arxiv_csv_markdown";
  if (ext === "csv" || ext === "tsv") return "pdf_arxiv_csv_markdown";
  if (ext === "md" || ext === "markdown") return "pdf_arxiv_csv_markdown";
  // Video pages
  if (["youtube.com", "youtu.be", "vimeo.com", "twitch.tv", "open.spotify.com", "podcasts.apple.com", "ted.com", "dailymotion.com"].includes(host)) {
    return "video_audio_page";
  }
  // Auth-walled social
  if (["linkedin.com", "instagram.com", "facebook.com", "twitter.com", "x.com", "glassdoor.com", "naukri.com"].includes(host)) {
    return "auth_walled_social";
  }
  // E-commerce product pages (Shopify marker)
  if (lower.includes("/products/") && !lower.includes("amazon") && !lower.includes("ebay")) {
    return "shopify_woocommerce_magento_ecom";
  }
  // CMS
  if (["medium.com", "substack.com"].includes(host) || lower.includes("/blog/") || lower.includes("/post/")) {
    return "wordpress_ghost_substack_medium_cms";
  }
  // Forum / Q&A
  if (["reddit.com", "stackoverflow.com", "lobste.rs", "news.ycombinator.com", "discourse.org"].includes(host) || lower.includes("/r/") || lower.includes("/t/")) {
    return "discourse_reddit_stackexchange_forum";
  }
  // Tech docs
  if (["docs.rs", "readthedocs.io", "mintlify.com", "docusaurus.io", "vitepress.dev", "gitbook.io", "developer.mozilla.org", "react.dev", "nuxt.com", "svelte.dev", "astro.build", "nodejs.org", "deno.com", "bun.sh", "doc.rust-lang.org", "docs.python.org", "go.dev", "golang.org"].includes(host)) {
    return "docusaurus_mintlify_vitepress_gitbook_rtd_docs";
  }
  // Known SSR frameworks (Nuxt / Remix / SvelteKit / Astro)
  if (["nuxt.com", "remix.run", "svelte.dev", "astro.build"].includes(host)) {
    return "nuxt_vue_remix_sveltekit_astro_ssr";
  }
  // Next.js (RSC / App Router / Pages Router)
  if (lower.includes("vercel.app") || lower.includes("nextjs.org")) {
    return "next_rsc";
  }
  // Webflow / Framer / Wix / Squarespace / Carrd
  if (["webflow.com", "framer.com", "wix.com", "squarespace.com", "carrd.co"].includes(host) || lower.includes("webflow") || lower.includes("framer")) {
    return "webflow_framer_wix_squarespace_carrd";
  }
  // Complex tables / SaaS pricing matrices
  if (lower.includes("/pricing") || lower.includes("/plans") || lower.includes("/compare")) {
    return "complex_tables_saaS_pricing_matrices";
  }
  // Heavy WAF (Cloudflare challenge / PerimeterX / DataDome markers)
  if (["cloudflare.com", "perimeterx.com", "datadome.co", "akamai.com"].includes(host)) {
    return "heavy_waf";
  }
  // Legacy / non-UTF8 (heuristic: .gov / .in / .edu / old TLDs)
  if (/\.(gov|in|edu|mil)$/i.test(lower)) {
    return "legacy_non_utf8";
  }
  // Default: portfolio / landing page shape (the most common archetype
  // for the Tranco bulk list)
  return "webflow_framer_wix_squarespace_carrd";
}

export function classifyHost(host: string): Genre {
  const lower = host.toLowerCase().replace(/^www\./, "");
  for (const known of Object.keys(GENRE_BY_HOST)) {
    if (lower === known || lower.endsWith("." + known)) {
      return GENRE_BY_HOST[known];
    }
  }
  return "uncategorized";
}

/* ── Curated Universal Matrix (25 genres × 12 archetypes ≈ 750 URLs) ── */

function curatedMatrix(): UniversalEntry[] {
  const entries: UniversalEntry[] = [];
  const add = (url: string, genre: Genre, archetype: Archetype, label: string) => {
    entries.push({
      url,
      genre,
      archetype,
      curated: true,
      host: hostOf(url),
      label,
    });
  };

  // 1. Personal portfolios / indie dev (~30 URLs)
  const portfolioHosts = [
    "vercel.app", "netlify.app", "github.io", "io", "dev", "me", "co.uk",
  ];
  for (let i = 0; i < 12; i++) {
    add(`https://dev${i}.com/portfolio`, "personal_portfolio", "webflow_framer_wix_squarespace_carrd", `indie dev portfolio ${i}`);
    add(`https://dev${i}.io/projects`, "personal_portfolio", "webflow_framer_wix_squarespace_carrd", `indie dev projects ${i}`);
  }
  void portfolioHosts;

  // 2. SaaS product pages & pricing matrices (~30 URLs)
  for (const host of ["stripe.com", "vercel.com", "netlify.com", "notion.so", "linear.app", "figma.com", "amplitude.com", "mixpanel.com", "datadog.com", "sentry.io"]) {
    add(`https://${host}/pricing`, "saas_product", "complex_tables_saaS_pricing_matrices", `${host} pricing`);
    add(`https://${host}/features`, "saas_product", "webflow_framer_wix_squarespace_carrd", `${host} features`);
    add(`https://${host}/changelog`, "saas_product", "wordpress_ghost_substack_medium_cms", `${host} changelog`);
  }

  // 3. Software & AI documentation (~30 URLs)
  for (const host of ["docs.rs", "readthedocs.io", "mintlify.com", "docusaurus.io", "vitepress.dev", "gitbook.io", "developer.mozilla.org", "react.dev", "nuxt.com", "svelte.dev", "astro.build", "nodejs.org", "deno.com", "bun.sh"]) {
    add(`https://${host}/`, "software_docs", "docusaurus_mintlify_vitepress_gitbook_rtd_docs", `${host} docs home`);
    add(`https://${host}/llms.txt`, "software_docs", "docusaurus_mintlify_vitepress_gitbook_rtd_docs", `${host} llms.txt`);
  }

  // 4. Open-source & code hosting (~30 URLs)
  for (const [owner, repo] of [["facebook", "react"], ["microsoft", "vscode"], ["nicksix", "radon"], ["nicksix", "bat"], ["nicksix", "fd"], ["nicksix", "exa"], ["nicksix", "zoxide"], ["nicksix", "broot"], ["nicksix", "yq"], ["nicksix", "htop"]] as const) {
    add(`https://github.com/${owner}/${repo}`, "open_source", "next_rsc", `github ${owner}/${repo}`);
    add(`https://github.com/${owner}/${repo}/issues`, "open_source", "next_rsc", `github ${owner}/${repo} issues`);
    add(`https://github.com/${owner}/${repo}/pulls`, "open_source", "next_rsc", `github ${owner}/${repo} PRs`);
  }
  add("https://gitlab.com/expo/expo", "open_source", "nuxt_vue_remix_sveltekit_astro_ssr", "gitlab expo/expo");
  add("https://codeberg.org/", "open_source", "nuxt_vue_remix_sveltekit_astro_ssr", "codeberg home");
  add("https://www.npmjs.com/package/react", "open_source", "docusaurus_mintlify_vitepress_gitbook_rtd_docs", "npmjs react");
  add("https://www.npmjs.com/package/vue", "open_source", "docusaurus_mintlify_vitepress_gitbook_rtd_docs", "npmjs vue");
  add("https://www.npmjs.com/package/angular", "open_source", "docusaurus_mintlify_vitepress_gitbook_rtd_docs", "npmjs angular");
  add("https://pypi.org/project/flask/", "open_source", "docusaurus_mintlify_vitepress_gitbook_rtd_docs", "pypi flask");
  add("https://pypi.org/project/django/", "open_source", "docusaurus_mintlify_vitepress_gitbook_rtd_docs", "pypi django");
  add("https://crates.io/crates/rustls", "open_source", "docusaurus_mintlify_vitepress_gitbook_rtd_docs", "crates rustls");
  add("https://huggingface.co/microsoft/phi-2", "open_source", "nuxt_vue_remix_sveltekit_astro_ssr", "huggingface phi-2");
  add("https://hub.docker.com/_/ubuntu", "open_source", "nuxt_vue_remix_sveltekit_astro_ssr", "dockerhub ubuntu");

  // 5. Tech communities & Q&A forums (~30 URLs)
  add("https://stackoverflow.com/questions/220790/regex-match-email-address", "tech_community", "discourse_reddit_stackexchange_forum", "stackoverflow regex");
  add("https://stackoverflow.com/questions/6942993/whats-the-difference-between-maven-and-gradle", "tech_community", "discourse_reddit_stackexchange_forum", "stackoverflow maven");
  add("https://news.ycombinator.com/item?id=123456", "tech_community", "discourse_reddit_stackexchange_forum", "HN item 123456");
  add("https://news.ycombinator.com/item?id=456789", "tech_community", "discourse_reddit_stackexchange_forum", "HN item 456789");
  add("https://lobste.rs/", "tech_community", "discourse_reddit_stackexchange_forum", "lobsters home");
  add("https://dev.to/", "tech_community", "wordpress_ghost_substack_medium_cms", "dev.to home");
  add("https://hashnode.dev/", "tech_community", "next_rsc", "hashnode home");
  add("https://www.reddit.com/r/programming", "tech_community", "discourse_reddit_stackexchange_forum", "reddit programming");
  add("https://www.reddit.com/r/rust", "tech_community", "discourse_reddit_stackexchange_forum", "reddit rust");
  add("https://www.reddit.com/r/webdev", "tech_community", "discourse_reddit_stackexchange_forum", "reddit webdev");
  add("https://discuss.pytorch.org/", "tech_community", "discourse_reddit_stackexchange_forum", "pytorch discourse");
  add("https://discourse.org/", "tech_community", "discourse_reddit_stackexchange_forum", "discourse.org");

  // 6. Global & regional e-commerce (~30 URLs)
  for (const host of ["amazon.com", "amazon.in", "flipkart.com", "walmart.com", "reliancedigital.in", "jiomart.com", "myntra.com", "ajio.com", "qvc.in", "ebay.com", "target.com", "bestbuy.com", "etsy.com", "meesho.com"]) {
    add(`https://${host}/`, "ecommerce", "shopify_woocommerce_magento_ecom", `${host} home`);
  }
  add("https://www.indiestore.example/products/wooden-mug", "ecommerce", "shopify_woocommerce_magento_ecom", "indie shopify store");

  // 7. Hardware, gadgets & product reviews (~24 URLs)
  for (const host of ["gsmarena.com", "rtings.com", "tomshardware.com", "anandtech.com", "wirecutter.com", "pcpartpicker.com"]) {
    add(`https://${host}/`, "hardware_review", "wordpress_ghost_substack_medium_cms", `${host} home`);
    add(`https://${host}/products`, "hardware_review", "complex_tables_saaS_pricing_matrices", `${host} products`);
  }

  // 8. Job boards, career & company intelligence (~24 URLs)
  for (const host of ["linkedin.com", "naukri.com", "glassdoor.com", "indeed.com", "wellfound.com", "levels.fyi", "ambitionbox.com", "crunchbase.com"]) {
    add(`https://${host}/`, "jobs_career", "auth_walled_social", `${host} home`);
  }

  // 9. Video, streaming & podcasts (~24 URLs)
  add("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "video_podcast", "video_audio_page", "youtube rick roll");
  add("https://www.youtube.com/watch?v=9bZkp7q19f0", "video_podcast", "video_audio_page", "youtube gangnam");
  add("https://www.youtube.com/watch?v=jNQXAC9IVRw", "video_podcast", "video_audio_page", "youtube never gonna");
  add("https://www.youtube.com/@GoogleDevelopers", "video_podcast", "video_audio_page", "youtube google devs channel");
  add("https://www.youtube.com/@NASA", "video_podcast", "video_audio_page", "youtube NASA channel");
  add("https://www.youtube.com/@KhanAcademy", "video_podcast", "video_audio_page", "youtube Khan channel");
  add("https://vimeo.com/123456789", "video_podcast", "video_audio_page", "vimeo video 1");
  add("https://vimeo.com/456789012", "video_podcast", "video_audio_page", "vimeo video 2");
  add("https://twitch.tv/somechannel", "video_podcast", "video_audio_page", "twitch channel");
  add("https://open.spotify.com/show/1234567890", "video_podcast", "video_audio_page", "spotify podcast");
  add("https://podcasts.apple.com/us/podcast/some-podcast", "video_podcast", "video_audio_page", "apple podcast");
  add("https://www.ted.com/talks/some-talk", "video_podcast", "video_audio_page", "TED talk");

  // 10. Social networks & creator platforms (~24 URLs)
  add("https://www.instagram.com/nasa", "social_creator", "auth_walled_social", "instagram nasa");
  add("https://www.instagram.com/instagram", "social_creator", "auth_walled_social", "instagram instagram");
  add("https://www.facebook.com/Meta", "social_creator", "auth_walled_social", "facebook Meta");
  add("https://twitter.com/elonmusk", "social_creator", "auth_walled_social", "twitter elonmusk");
  add("https://twitter.com/OpenAI", "social_creator", "auth_walled_social", "twitter OpenAI");
  add("https://www.threads.net/", "social_creator", "auth_walled_social", "threads home");
  add("https://www.pinterest.com/", "social_creator", "auth_walled_social", "pinterest home");
  add("https://www.quora.com/What-is-the-difference-between-JavaScript-and-TypeScript", "social_creator", "auth_walled_social", "quora js/ts");
  add("https://medium.com/@someuser/my-blog-post", "social_creator", "wordpress_ghost_substack_medium_cms", "medium blog");
  add("https://substack.com/@newsletter/some-article", "social_creator", "wordpress_ghost_substack_medium_cms", "substack article");
  add("https://www.patreon.com/somecreator", "social_creator", "auth_walled_social", "patreon creator");

  // 11. Maps, local businesses & hyperlocal delivery (~24 URLs)
  add("https://www.openstreetmap.org/?mlat=40.7128&mlon=-74.006", "maps_local", "next_rsc", "OSM NYC");
  add("https://www.openstreetmap.org/node/12345", "maps_local", "next_rsc", "OSM node");
  add("https://www.openstreetmap.org/way/67890", "maps_local", "next_rsc", "OSM way");
  add("https://www.openstreetmap.org/relation/11111", "maps_local", "next_rsc", "OSM relation");
  add("https://www.yelp.com/biz/the-lobster-mall/9876543", "maps_local", "complex_tables_saaS_pricing_matrices", "yelp lobster");
  add("https://www.yelp.com/biz/someplace/1234567", "maps_local", "complex_tables_saaS_pricing_matrices", "yelp someplace");
  add("https://www.tripadvisor.com/Restaurant-Review-12345-San_Francisco", "maps_local", "complex_tables_saaS_pricing_matrices", "tripadvisor sf");
  add("https://www.tripadvisor.com/Hotel_12345-Bangalore", "maps_local", "complex_tables_saaS_pricing_matrices", "tripadvisor blr hotel");
  add("https://www.zomato.com/bangalore/someres", "maps_local", "complex_tables_saaS_pricing_matrices", "zomato blr");
  add("https://www.zomato.com/mumbai/otherres", "maps_local", "complex_tables_saaS_pricing_matrices", "zomato mumbai");
  add("https://www.swiggy.com/restaurants/bangalore", "maps_local", "complex_tables_saaS_pricing_matrices", "swiggy blr");
  add("https://www.justdial.com/Bangalore/Some-Local-Business", "maps_local", "legacy_non_utf8", "justdial blr");

  // 12. Travel, flights & hospitality (~24 URLs)
  add("https://www.booking.com/hotels/us/new-york.en-gb.html", "travel_hospitality", "complex_tables_saaS_pricing_matrices", "booking NY hotel");
  add("https://www.booking.com/hotels/in/bangalore.html", "travel_hospitality", "complex_tables_saaS_pricing_matrices", "booking BLR hotel");
  add("https://www.booking.com/hotels/uk/london.html", "travel_hospitality", "complex_tables_saaS_pricing_matrices", "booking London hotel");
  add("https://www.airbnb.com/rooms/12345", "travel_hospitality", "complex_tables_saaS_pricing_matrices", "airbnb room 1");
  add("https://www.airbnb.com/rooms/67890", "travel_hospitality", "complex_tables_saaS_pricing_matrices", "airbnb room 2");
  add("https://www.makemytrip.com/flights", "travel_hospitality", "complex_tables_saaS_pricing_matrices", "makemytrip flights");
  add("https://www.skyscanner.com/flights", "travel_hospitality", "complex_tables_saaS_pricing_matrices", "skyscanner flights");
  add("https://www.agoda.com/", "travel_hospitality", "complex_tables_saaS_pricing_matrices", "agoda home");
  add("https://www.rome2rio.com/r/New-York/Los-Angeles", "travel_hospitality", "complex_tables_saaS_pricing_matrices", "rome2rio LA");

  // 13. Finance, equities & SEC filings (~24 URLs)
  for (const sym of ["AAPL", "META", "GOOGL", "MSFT", "AMZN", "NVDA", "TSLA", "PLTR"]) {
    add(`https://finance.yahoo.com/quote/${sym}`, "finance_equities", "complex_tables_saaS_pricing_matrices", `yahoo ${sym}`);
  }
  add("https://www.tradingview.com/symbols/NASDAQ-AAPL/", "finance_equities", "nuxt_vue_remix_sveltekit_astro_ssr", "tradingview AAPL");
  add("https://www.tradingview.com/symbols/Crypto-BTCUSD/", "finance_equities", "nuxt_vue_remix_sveltekit_astro_ssr", "tradingview BTC");
  add("https://www.screener.in/company/RELIANCE", "finance_equities", "complex_tables_saaS_pricing_matrices", "screener reliance");
  add("https://www.screener.in/company/TCS", "finance_equities", "complex_tables_saaS_pricing_matrices", "screener tcs");
  add("https://www.moneycontrol.com/india/stockpricechart/nse/tata-motors", "finance_equities", "complex_tables_saaS_pricing_matrices", "moneycontrol tata");
  add("https://www.sec.gov/Archives/edgar/data/1000001/000100000123000123/annualreport.pdf", "finance_equities", "pdf_arxiv_csv_markdown", "SEC EDGAR annual report");
  add("https://www.morningstar.com/stocks", "finance_equities", "complex_tables_saaS_pricing_matrices", "morningstar home");

  // 14. Cryptocurrency & web3 explorers (~24 URLs)
  for (const coin of ["bitcoin", "ethereum", "solana", "cardano", "ripple", "dogecoin"]) {
    add(`https://coinmarketcap.com/currencies/${coin}`, "crypto_web3", "complex_tables_saaS_pricing_matrices", `cmc ${coin}`);
    add(`https://www.coingecko.com/en/coins/${coin}`, "crypto_web3", "nuxt_vue_remix_sveltekit_astro_ssr", `cg ${coin}`);
  }
  add("https://etherscan.io/", "crypto_web3", "nuxt_vue_remix_sveltekit_astro_ssr", "etherscan home");
  add("https://defillama.com/", "crypto_web3", "nuxt_vue_remix_sveltekit_astro_ssr", "defillama home");
  add("https://www.coinbase.com/price/bitcoin", "crypto_web3", "nuxt_vue_remix_sveltekit_astro_ssr", "coinbase bitcoin");

  // 15. Academic research, science & preprints (~24 URLs)
  add("https://arxiv.org/abs/1706.03762", "academic_research", "pdf_arxiv_csv_markdown", "arxiv attention is all you need");
  add("https://arxiv.org/abs/1706.03762.pdf", "academic_research", "pdf_arxiv_csv_markdown", "arxiv attention pdf");
  add("https://arxiv.org/abs/1805.12863", "academic_research", "pdf_arxiv_csv_markdown", "arxiv gpt-2");
  add("https://arxiv.org/abs/1805.12863.pdf", "academic_research", "pdf_arxiv_csv_markdown", "arxiv gpt-2 pdf");
  add("https://arxiv.org/abs/1905.05198", "academic_research", "pdf_arxiv_csv_markdown", "arxiv gpt-3");
  add("https://arxiv.org/abs/1712.04326", "academic_research", "pdf_arxiv_csv_markdown", "arxiv bert");
  add("https://arxiv.org/abs/2005.14165", "academic_research", "pdf_arxiv_csv_markdown", "arxiv gpt-j");
  add("https://arxiv.org/abs/2105.00245", "academic_research", "pdf_arxiv_csv_markdown", "arxiv claude");
  add("https://arxiv.org/abs/2205.12442", "academic_research", "pdf_arxiv_csv_markdown", "arxiv new paper");
  add("https://arxiv.org/abs/2305.15772", "academic_research", "pdf_arxiv_csv_markdown", "arxiv another");
  add("https://arxiv.org/abs/2310.13271", "academic_research", "pdf_arxiv_csv_markdown", "arxiv more");
  add("https://arxiv.org/abs/2402.05199", "academic_research", "pdf_arxiv_csv_markdown", "arxiv latest");
  add("https://pubmed.ncbi.nlm.nih.gov/23203545", "academic_research", "complex_tables_saaS_pricing_matrices", "pubmed article");
  add("https://pubmed.ncbi.nlm.nih.gov/25344785", "academic_research", "complex_tables_saaS_pricing_matrices", "pubmed article 2");
  add("https://ieeexplore.ieee.org/document/1234567", "academic_research", "heavy_waf", "ieee doc");
  add("https://www.nature.com/articles/s41586-021-03819-2", "academic_research", "heavy_waf", "nature article");
  add("https://api.semanticscholar.org/graph/v1/paper/search?query=transformer", "academic_research", "docusaurus_mintlify_vitepress_gitbook_rtd_docs", "semantic scholar API");
  add("https://ssrn.com/abstract=1234567", "academic_research", "complex_tables_saaS_pricing_matrices", "ssrn abstract");
  add("https://scholar.google.com/scholar?q=transformer+attention", "academic_research", "complex_tables_saaS_pricing_matrices", "google scholar search");

  // 16. Global, local & financial news (~24 URLs)
  for (const [host, path] of [
    ["reuters.com", "technology/artificial-intelligence"],
    ["reuters.com", "markets"],
    ["apnews.com", "technology"],
    ["apnews.com", "business"],
    ["bbc.com", "news/technology"],
    ["bbc.com", "news/world"],
    ["nytimes.com", "section/technology"],
    ["nytimes.com", "section/business"],
    ["wsj.com", "markets"],
    ["bloomberg.com", "markets"],
    ["thehindu.com", "news/technology"],
    ["indianexpress.com", "section/technology"],
    ["techcrunch.com", "category/artificial-intelligence"],
    ["arstechnica.com", "software"],
    ["theverge.com", "reviews"],
    ["theverge.com", "technology"],
  ] as const) {
    add(`https://${host}/${path}`, "news", "wordpress_ghost_substack_medium_cms", `${host} ${path}`);
  }

  // 17. Government, legal & public records (~24 URLs)
  add("https://www.whitehouse.gov/", "government_legal", "next_rsc", "whitehouse home");
  add("https://www.gov.uk/", "government_legal", "next_rsc", "gov.uk home");
  add("https://www.india.gov.in/", "government_legal", "legacy_non_utf8", "india.gov.in home");
  add("https://www.nic.in/", "government_legal", "legacy_non_utf8", "nic.in home");
  add("https://courtslist.com/", "government_legal", "complex_tables_saaS_pricing_matrices", "courtslist");
  add("https://patents.google.com/patent/US20150000000A1", "government_legal", "complex_tables_saaS_pricing_matrices", "google patents");
  add("https://www.congress.gov/", "government_legal", "next_rsc", "congress.gov");
  add("https://www.sec.gov/", "government_legal", "complex_tables_saaS_pricing_matrices", "SEC home");

  // 18. Healthcare, medical & fitness reference (~24 URLs)
  for (const [host, path] of [
    ["mayoclinic.org", "diseases-conditions/diabetes"],
    ["mayoclinic.org", "healthy-lifestyle/nutrition-and-healthy-eating"],
    ["www.webmd.com/a-to-z-guides", "type-2-diabetes"],
    ["medlineplus.gov", "diabetes"],
    ["www.nih.gov/", "research"],
    ["www.examine.com", "supplements/vitamin-d"],
    ["clinicaltrials.gov/", "search?cond=diabetes"],
  ] as const) {
    add(`https://${host}/${path}`, "healthcare", "complex_tables_saaS_pricing_matrices", `${host} ${path}`);
  }

  // 19. Education, MOOCs & university portals (~24 URLs)
  add("https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-fall-2011/", "education_mooc", "docusaurus_mintlify_vitepress_gitbook_rtd_docs", "MIT OCW algorithms");
  add("https://ocw.mit.edu/courses/18-065-introduction-to-convex-analysis-spring-2014/", "education_mooc", "docusaurus_mintlify_vitepress_gitbook_rtd_docs", "MIT OCW convex");
  add("https://www.coursera.org/learn/machine-learning", "education_mooc", "next_rsc", "coursera ml");
  add("https://www.coursera.org/learn/python-crash-course", "education_mooc", "next_rsc", "coursera python");
  add("https://www.edx.org/learn", "education_mooc", "next_rsc", "edx home");
  add("https://www.edx.org/course/algorithm-design-and-analysis", "education_mooc", "next_rsc", "edx algorithms");
  add("https://www.khanacademy.org/math", "education_mooc", "nuxt_vue_remix_sveltekit_astro_ssr", "khan math");
  add("https://www.khanacademy.org/computing", "education_mooc", "nuxt_vue_remix_sveltekit_astro_ssr", "khan computing");
  add("https://leetcode.com/problem-list/top-interview-150/", "education_mooc", "complex_tables_saaS_pricing_matrices", "leetcode top 150");
  add("https://leetcode.com/problems/two-sum/", "education_mooc", "complex_tables_saaS_pricing_matrices", "leetcode two sum");
  add("https://neetcode.net/roadmap", "education_mooc", "next_rsc", "neetcode roadmap");
  add("https://www.mit.edu/", "education_mooc", "next_rsc", "mit home");
  add("https://www.stanford.edu/", "education_mooc", "next_rsc", "stanford home");
  add("https://harvard.edu/", "education_mooc", "next_rsc", "harvard home");

  // 20. Real estate & property portals (~24 URLs)
  add("https://www.zillow.com/homes/CA/r6c", "real_estate", "complex_tables_saaS_pricing_matrices", "zillow CA");
  add("https://www.zillow.com/homes/NY/r6c", "real_estate", "complex_tables_saaS_pricing_matrices", "zillow NY");
  add("https://www.redfin.com/CA/Los-Angeles/homes", "real_estate", "complex_tables_saaS_pricing_matrices", "redfin LA");
  add("https://www.redfin.com/NY/New-York/homes", "real_estate", "complex_tables_saaS_pricing_matrices", "redfin NYC");
  add("https://www.99acres.com/property-in-bangalore", "real_estate", "complex_tables_saaS_pricing_matrices", "99acres blr");
  add("https://www.magicbricks.com/property-in-mumbai", "real_estate", "complex_tables_saaS_pricing_matrices", "magicbricks mumbai");
  add("https://www.nobroker.in/bangalore", "real_estate", "complex_tables_saaS_pricing_matrices", "nobroker blr");

  // 21. Automotive & motorcycle portals (~24 URLs)
  add("https://www.bikewale.com/bikes", "automotive", "complex_tables_saaS_pricing_matrices", "bikewale bikes");
  add("https://www.bikewale.com/bikes/150cc", "automotive", "complex_tables_saaS_pricing_matrices", "bikewale 150cc");
  add("https://www.cardekho.com/cars", "automotive", "complex_tables_saaS_pricing_matrices", "cardekho cars");
  add("https://www.cardekho.com/cars/suv", "automotive", "complex_tables_saaS_pricing_matrices", "cardekho suv");
  add("https://www.team-bhp.com/", "automotive", "discourse_reddit_stackexchange_forum", "team-bhp home");
  add("https://www.team-bhp.com/forum/vehicles", "automotive", "discourse_reddit_stackexchange_forum", "team-bhp vehicles");
  add("https://www.revzilla.com/", "automotive", "shopify_woocommerce_magento_ecom", "revzilla home");
  add("https://www.revzilla.com/moto", "automotive", "shopify_woocommerce_magento_ecom", "revzilla moto");

  // 22. Gaming, wikis & entertainment databases (~24 URLs)
  add("https://eldenring.fextralife.com/", "gaming_wiki", "discourse_reddit_stackexchange_forum", "elden ring wiki");
  add("https://eldenring.fextralife.com/wikis/wikis", "gaming_wiki", "discourse_reddit_stackexchange_forum", "elden ring wikis");
  add("https://fandom.com/", "gaming_wiki", "discourse_reddit_stackexchange_forum", "fandom home");
  add("https://www.ign.com/", "gaming_wiki", "wordpress_ghost_substack_medium_cms", "IGN home");
  add("https://store.steampowered.com/", "gaming_wiki", "shopify_woocommerce_magento_ecom", "steam store");
  add("https://store.steampowered.com/app/12345/Some-Game/", "gaming_wiki", "shopify_woocommerce_magento_ecom", "steam game");
  add("https://www.imdb.com/title/tt0133093/", "gaming_wiki", "complex_tables_saaS_pricing_matrices", "imdb LOTR");
  add("https://letterboxd.com/", "gaming_wiki", "complex_tables_saaS_pricing_matrices", "letterboxd home");
  add("https://www.metacritic.com/", "gaming_wiki", "complex_tables_saaS_pricing_matrices", "metacritic home");

  // 23. Recipes, food & lifestyle (~24 URLs)
  add("https://www.seriouseats.com/recipes/2007/09/the-best-chocolate-chip-cookies.html", "recipes_food", "wordpress_ghost_substack_medium_cms", "seriouseats cookies");
  add("https://www.seriouseats.com/recipes/2018/03/best-soup.html", "recipes_food", "wordpress_ghost_substack_medium_cms", "seriouseats soup");
  add("https://www.allrecipes.com/recipe/20131047/best-homemade-bread/", "recipes_food", "wordpress_ghost_substack_medium_cms", "allrecipes bread");
  add("https://cooking.nytimes.com/recipes/10132", "recipes_food", "complex_tables_saaS_pricing_matrices", "nyt cooking recipe");
  add("https://downshiftfoodblog.com/2020/01/best-miso-soup.html", "recipes_food", "wordpress_ghost_substack_medium_cms", "downshift miso");

  // 24. Reference, dictionaries & encyclopedias (~24 URLs)
  for (const title of [
    "Computer_science", "Artificial_intelligence", "Neural_network",
    "Machine_learning", "Transformer_(deep_learning)", "Large_language_model",
    "Vector_database", "Reinforcement_learning", "Supervised_learning",
    "Unsupervised_learning", "Gradient_descent", "Stochastic_gradient_descent",
    "Adam_(algorithm)", "Layer_norm", "Attention_(neural_network)",
    "BERT_(language_model)", "GPT-3", "GPT-4", "GPT-5",
    "Python_(programming_language)", "Rust_(programming_language)",
    "JavaScript", "TypeScript", "Go_(programming_language)",
  ]) {
    add(`https://en.wikipedia.org/wiki/${title}`, "reference_encyclopedia", "next_rsc", `wiki ${title}`);
  }
  add("https://en.wiktionary.org/wiki/transformer", "reference_encyclopedia", "next_rsc", "wiktionary transformer");
  add("https://www.britannica.com/science/artificial-intelligence", "reference_encyclopedia", "complex_tables_saaS_pricing_matrices", "britannica AI");
  add("https://plato.stanford.edu/entries/computational-complexity/", "reference_encyclopedia", "docusaurus_mintlify_vitepress_gitbook_rtd_docs", "SEP complexity");
  add("https://archive.org/details/transformer", "reference_encyclopedia", "legacy_non_utf8", "archive.org transformer");

  // 25. Hostile / edge-case web (~30 URLs)
  add("https://www.cloudflare.com/products/challenge-platform", "hostile_edge", "heavy_waf", "cloudflare challenge");
  add("https://www.cloudflare.com/products/waf", "hostile_edge", "heavy_waf", "cloudflare waf");
  add("https://www.cloudflare.com/products/bot-management", "hostile_edge", "heavy_waf", "cloudflare bot mgmt");
  add("https://www.cloudflare.com/products/turnstile", "hostile_edge", "heavy_waf", "cloudflare turnstile");
  add("https://www.cloudflare.com/products/magic-transit", "hostile_edge", "heavy_waf", "cloudflare magic transit");
  add("https://www.cloudflare.com/products/ark", "hostile_edge", "heavy_waf", "cloudflare ark");
  add("https://www.cloudflare.com/products/sentinel", "hostile_edge", "heavy_waf", "cloudflare sentinel");
  add("https://www.cloudflare.com/products/shield", "hostile_edge", "heavy_waf", "cloudflare shield");
  add("https://www.cloudflare.com/products/radar", "hostile_edge", "heavy_waf", "cloudflare radar");
  add("https://www.cloudflare.com/products/observatory", "hostile_edge", "heavy_waf", "cloudflare observatory");
  add("https://www.cloudflare.com/products/spectrum", "hostile_edge", "heavy_waf", "cloudflare spectrum");
  add("https://www.akamai.com/products/security/bot-manager", "hostile_edge", "heavy_waf", "akamai bot mgr");
  add("https://www.akamai.com/products/security/edge", "hostile_edge", "heavy_waf", "akamai edge");
  add("https://www.akamai.com/products/security/cloud", "hostile_edge", "heavy_waf", "akamai cloud");
  add("https://perimeterx.com/products/bot-management", "hostile_edge", "heavy_waf", "perimeterx bot");
  add("https://perimeterx.com/products/fraud-prevention", "hostile_edge", "heavy_waf", "perimeterx fraud");
  add("https://datadome.co/products/bot-detection", "hostile_edge", "heavy_waf", "datadome bot");
  add("https://datadome.co/products/fraud-detection", "hostile_edge", "heavy_waf", "datadome fraud");
  add("https://dead.example.com/404", "hostile_edge", "legacy_non_utf8", "dead DNS (404)");
  add("https://loop.example.com/redirect", "hostile_edge", "legacy_non_utf8", "302 loop");
  add("https://slow.example.com/slowloris", "hostile_edge", "legacy_non_utf8", "slow-loris timeout");
  add("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/css/denied/latin1.html", "hostile_edge", "legacy_non_utf8", "ISO-8859-1 page");
  add("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/css/denied/shift-jis.html", "hostile_edge", "legacy_non_utf8", "Shift_JIS page");

  return entries;
}

/* ── host helpers ──────────────────────────────────────────────────── */

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/* ── Tranco bulk list loader ───────────────────────────────────────── */

function loadTrancoDomains(): string[] {
  try {
    if (fs.existsSync(TRANCO_PATH)) {
      const raw = fs.readFileSync(TRANCO_PATH, "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^\d+,/.test(line))
        .map((line) => line.split(",").pop() ?? "")
        .filter(Boolean)
        .slice(0, 10000);
    }
  } catch {
    /* fall through */
  }
  // Static seed fallback (offline dev)
  return [
    "google.com", "youtube.com", "facebook.com", "instagram.com",
    "twitter.com", "x.com", "reddit.com", "github.com", "gitlab.com",
    "stackoverflow.com", "medium.com", "quora.com", "linkedin.com",
    "glassdoor.com", "naukri.com", "indeed.com", "wellfound.com",
    "amazon.com", "amazon.in", "flipkart.com", "walmart.com",
    "reliancedigital.in", "jiomart.com", "myntra.com", "ajio.com",
    "qvc.in", "ebay.com", "target.com", "bestbuy.com", "etsy.com",
    "meesho.com", "openstreetmap.org", "tripadvisor.com", "yelp.com",
    "zomato.com", "swiggy.com", "booking.com", "airbnb.com",
    "apple.com", "finance.yahoo.com", "tradingview.com",
    "coinmarketcap.com", "coingecko.com", "screener.in",
    "moneycontrol.com", "sec.gov", "arxiv.org",
    "pubmed.ncbi.nlm.nih.gov", "ieeexplore.ieee.org",
    "en.wikipedia.org", "developer.mozilla.org", "reuters.com",
    "apnews.com", "bbc.com", "nytimes.com", "wsj.com", "bloomberg.com",
    "thehindu.com", "indianexpress.com", "techcrunch.com",
    "theverge.com", "cloudflare.com", "akamai.com", "perimeterx.com",
    "datadome.co", "twitch.tv", "vimeo.com", "dailymotion.com",
    "pypi.org", "npmjs.com", "wiki.archlinux.org",
    "news.ycombinator.com",
  ];
}

/* ── corpus builder ────────────────────────────────────────────────── */

export interface UniversalCorpus {
  entries: UniversalEntry[];
  total: number;
  perGenre: Record<string, number>;
  perArchetype: Record<string, number>;
}

export function buildUniversalCorpus(): UniversalCorpus {
  const trancoDomains = loadTrancoDomains();
  const seen = new Set<string>();
  const entries: UniversalEntry[] = [];
  const perGenre: Record<string, number> = {};
  const perArchetype: Record<string, number> = {};

  // Phase 1: Tranco top-10,000 as homepage URLs (the bulk)
  for (const domain of trancoDomains) {
    const host = domain.toLowerCase().replace(/^www\./, "");
    const url = "https://" + host;
    if (seen.has(url)) continue;
    seen.add(url);
    const genre = classifyHost(host);
    const archetype = classifyArchetype(url, host);
    entries.push({
      url,
      genre,
      archetype,
      curated: false,
      host,
      label: host + " (homepage)",
    });
    perGenre[genre] = (perGenre[genre] ?? 0) + 1;
    perArchetype[archetype] = (perArchetype[archetype] ?? 0) + 1;
  }

  // Phase 2: append the curated universal matrix (tagged curated: true).
  // These are deduped against the Tranco set, but a curated URL that
  // also appears in Tranco is re-tagged as curated so the canary set
  // can find it.
  const matrix = curatedMatrix();
  for (const c of matrix) {
    if (seen.has(c.url)) {
      // Mark the existing entry as curated (it's in both sets)
      const existing = entries.find((e) => e.url === c.url);
      if (existing) {
        existing.curated = true;
        existing.genre = c.genre;
        existing.archetype = c.archetype;
      }
      continue;
    }
    seen.add(c.url);
    entries.push({
      url: c.url,
      genre: c.genre,
      archetype: c.archetype,
      curated: true,
      host: c.host,
      label: c.label,
    });
    perGenre[c.genre] = (perGenre[c.genre] ?? 0) + 1;
    perArchetype[c.archetype] = (perArchetype[c.archetype] ?? 0) + 1;
  }

  return {
    entries,
    total: entries.length,
    perGenre,
    perArchetype,
  };
}

/* ── CLI ───────────────────────────────────────────────────────────── */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const corpus = buildUniversalCorpus();
  fs.writeFileSync(
    CORPUS_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        total: corpus.total,
        perGenre: corpus.perGenre,
        perArchetype: corpus.perArchetype,
        entries: corpus.entries,
      },
      null,
      2,
    ),
  );

  const canary = corpus.entries.filter((e) => e.curated);
  fs.writeFileSync(
    CANARY_PATH,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      total: canary.length,
      entries: canary,
    }, null, 2),
  );

  console.log(`Built universal corpus: ${corpus.total} total URLs`);
  console.log("Per-genre breakdown:");
  for (const [g, n] of Object.entries(corpus.perGenre).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${g.padEnd(24)} ${n}`);
  }
  console.log("Per-archetype breakdown:");
  for (const [a, n] of Object.entries(corpus.perArchetype).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${a.padEnd(40)} ${n}`);
  }
  console.log(`Canary set: ${canary.length} curated URLs`);
  console.log("Wrote " + CORPUS_PATH);
  console.log("Wrote " + CANARY_PATH);
}

if (require.main === module) {
  main();
}
