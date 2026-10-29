//! Search-engine benchmark harness (perf program: request/search-decision ->
//! evidence-ready, nothing after). Drives each search engine directly over a
//! fixed query set; NO model call is made, so this runs without the shared
//! model lock. Attribution: every engine task owns its own BenchNet, so the
//! per-attempt HTTP status histogram is exact per engine.
//!
//! Run:  cargo run -p ruke-websearch --example engine_bench -- <out-csv>
//! Trace logs (per-cycle instrumentation from the lib) land on stderr; set
//! RUST_LOG=info to capture them.
//!
//! Note on breakers: the circuit breaker is process-global and may skip
//! later calls for an engine that zeroed twice inside the streak window.
//! Skips are recorded as attempts=0 rows — the raw zero-rate is computed
//! over ATTEMPTED calls only, skips are reported separately.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use ruke_websearch::engines::{
    bing_news_rss_search, bing_search, brave_search, ddg_lite_post, ddg_search, dev_to_search,
    github_search, google_search, reddit_search, yahoo_search, EngineFn,
};
use ruke_websearch::metasearch::{
    arxiv_search, hackernews_search, imdb_suggestion_search, metasearch, semantic_scholar_search,
    stack_exchange_search, wikidata_search, wikipedia_search, SearchPlan,
};
use ruke_websearch::net::{FetchPageOpts, Net, PageResponse, RealNet, UrlFetchOpts, UrlFetchResult};
use ruke_websearch::types::{Freshness, Intent, RawSearchResult};

/* ── query set: ~60 representative queries across types ─────────────────── */

const QUERIES: &[&str] = &[
    // factoid / general
    "what is the capital of australia",
    "how tall is mount everest",
    "who wrote one hundred years of solitude",
    "boiling point of ethanol at sea level",
    "what year did the berlin wall fall",
    "average lifespan of a golden retriever",
    "difference between http and https",
    "what causes northern lights",
    "largest ocean by surface area",
    "currency of switzerland",
    // comparisons / decisions
    "rust vs go backend performance",
    "postgres vs mysql which to choose 2026",
    "best budget noise cancelling headphones",
    "notion vs obsidian for note taking",
    "srtm vs gpx for hiking tracks",
    // dev / code / docs
    "tokio select cancel child task on drop",
    "next.js dynamic import ssr false chunk error",
    "python requests retry backoff urllib3",
    "typescript satisfies operator example",
    "docker buildx cache mount layer",
    "react useEffect cleanup function double invoke",
    "sql window function running total example",
    "rust iterator take while collect",
    "axios interceptor refresh token queue",
    "css container queries browser support",
    // news-sensitive
    "openai latest model announcement",
    "fed rate decision this month",
    "spacex starship launch news",
    "eu ai act enforcement update",
    "nvidia earnings report quarter",
    // shopping / commercial intent
    "steam deck vs asus ally x review",
    "best standing desk under 500",
    "iphone 17 pro max price release",
    "rtx 5070 ti stock availability",
    "lego icons collection restock",
    // local / maps intent
    "best ramen near portland oregon",
    "hiking trails near banff national park",
    "coworking spaces austin tx",
    "farmers market schedule seattle",
    // academic
    "attention is all you need paper",
    "diffusion models image generation survey",
    "quantum error correction google willow",
    "crate diversity and protein folding",
    "climate tipping points amazon rainforest study",
    // forum / community / opinion
    "reddit best hobby cnc router beginner",
    "hacker news show ask sqlite serialization",
    "is it worth learning rust in 2026",
    "personal site experience slow hosting",
    // people / profile
    "satya nadella linkedin",
    "karpinsky founder elasticsearch profile",
    "director of photography blade runner 2049",
    // waf-heavy / bot-hostile targets
    "site:reddit.com homelab nas recommendation",
    "best browser for 32gb ram laptop reddit thread",
    "yelp mcp server auth",
    "linkedin learning subscription worth it",
    "quora answer why do cats purr",
    // long-tail / date-sensitive
    "when does daylight saving time end in europe 2026",
    "latest stable linux kernel release notes",
    "world population ranking countries 2026",
];

/* ── BenchNet: records exact per-engine HTTP outcomes ───────────────────── */

#[derive(Default)]
struct BenchNet {
    // (status, ok) per fetch attempt; status 0 = transport dead/None.
    rec: Mutex<Vec<(u16, bool)>>,
}

impl BenchNet {
    fn drain(&self, base: usize) -> Vec<(u16, bool)> {
        self.rec.lock().unwrap().drain(base..).collect()
    }
}

impl Net for BenchNet {
    // Owned-clone pattern exactly like RealNet's impl (net.rs 1306-1326);
    // direct &str/&opts params captured across the box fail borrowck there.
    fn fetch_page(&self, url: &str, opts: &FetchPageOpts) -> BoxFuture<'_, Option<PageResponse>> {
        let u = url.to_string();
        let o = opts.clone();
        let rec = &self.rec;
        Box::pin(async move {
            let r = RealNet.fetch_page(&u, &o).await;
            rec.lock()
                .unwrap()
                .push(match &r { Some(p) => (p.status, p.ok), None => (0, false) });
            r
        })
    }
    fn fetch_url(&self, url: &str, opts: &UrlFetchOpts) -> BoxFuture<'_, Option<UrlFetchResult>> {
        let u = url.to_string();
        let o = opts.clone();
        let rec = &self.rec;
        Box::pin(async move {
            let r = RealNet.fetch_url(&u, &o).await;
            rec.lock()
                .unwrap()
                .push(match &r { Some(u2) => (u2.status, u2.ok), None => (0, false) });
            r
        })
    }
    fn fetch_with_link_preview_bots(
        &self,
        url: &str,
        timeout_ms: u64,
        limit_bytes: usize,
    ) -> BoxFuture<'_, Option<PageResponse>> {
        let u = url.to_string();
        let rec = &self.rec;
        Box::pin(async move {
            let r = RealNet.fetch_with_link_preview_bots(&u, timeout_ms, limit_bytes).await;
            rec.lock()
                .unwrap()
                .push(match &r { Some(p) => (p.status, p.ok), None => (0, false) });
            r
        })
    }
}

/* ── metrics ────────────────────────────────────────────────────────────── */

struct Row {
    engine: &'static str,
    qi: usize,
    ms: u64,
    n: usize,
    uniq_domains: usize,
    dup_ratio: f64,
    relevant: usize,
    dated: usize,
    attempts: usize,
    statuses: String,
}

fn tokens(q: &str) -> HashSet<String> {
    q.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 3)
        .map(str::to_string)
        .collect()
}

fn measure(q: &str, name: &'static str, qi: usize, ms: u64, results: &[RawSearchResult], attempts: &[(u16, bool)]) -> Row {
    let qt = tokens(q);
    let mut domains = HashSet::new();
    let mut relevant = 0usize;
    let mut dated = 0usize;
    for r in results {
        if let Ok(u) = url::Url::parse(&r.url) {
            if let Some(h) = u.host_str() {
                domains.insert(h.trim_start_matches("www.").to_string());
            }
        }
        let text = format!("{} {}", r.title, r.snippet).to_lowercase();
        let hits = qt.iter().filter(|t| text.contains(t.as_str())).count();
        if hits >= 2 {
            relevant += 1;
        }
        if r.published_date.is_some() {
            dated += 1;
        }
    }
    let mut hist: HashMap<u16, usize> = HashMap::new();
    for (s, _) in attempts {
        *hist.entry(*s).or_default() += 1;
    }
    let statuses = {
        let mut v: Vec<(u16, usize)> = hist.into_iter().collect();
        v.sort();
        v.iter().map(|(s, c)| format!("{s}x{c}")).collect::<Vec<_>>().join("|")
    };
    let dup_ratio = if results.is_empty() {
        0.0
    } else {
        1.0 - domains.len() as f64 / results.len() as f64
    };
    Row { engine: name, qi, ms, n: results.len(), uniq_domains: domains.len(), dup_ratio, relevant, dated, attempts: attempts.len(), statuses }
}

async fn bench_engine(name: &'static str, f: EngineFn, queries: &[&'static str]) -> Vec<Row> {
    let net = BenchNet::default();
    let mut rows = Vec::new();
    for (qi, q) in queries.iter().enumerate() {
        let base = { net.rec.lock().unwrap().len() };
        let t = Instant::now();
        // 30s harness cap: engine wrappers self-cap at ENGINE_TIMEOUT_MS=40s;
        // the harness only needs to bound a hung stage against the 63-call
        // total, not outlast the engine's own deadline.
        let res = tokio::time::timeout(Duration::from_secs(30), f(&net, q))
            .await
            .unwrap_or_default();
        let ms = t.elapsed().as_millis() as u64;
        let attempts = net.drain(base);
        rows.push(measure(q, name, qi, ms, &res, &attempts));
    }
    rows
}

async fn bench_metasearch_cycle(qs: &[&'static str]) -> Vec<Row> {
    // Full search cycle (pool race + verticals + RRF + relevance floor), one
    // plan per query, sequential (global pacers serialize anyway).
    let net = RealNet;
    let mut rows = Vec::new();
    for (qi, q) in qs.iter().enumerate() {
        let plans = [SearchPlan {
            query: q.to_string(),
            intent: Intent::General,
            preferred_domains: None,
            freshness: Some(Freshness::Any),
            relevance_anchor: None,
        }];
        let t = Instant::now();
        let ranked = metasearch(&net, &plans, 20).await;
        let ms = t.elapsed().as_millis() as u64;
        // Reuse the same attribution shape with no per-attempt statuses
        // (RealNet direct); n/rel/domains come from the fused output.
        let fake: Vec<(u16, bool)> = Vec::new();
        let as_raw: Vec<RawSearchResult> = ranked
            .iter()
            .map(|r| RawSearchResult {
                title: r.title.clone(),
                url: r.url.clone(),
                snippet: r.snippet.clone(),
                engine: r.engine.clone(),
                published_date: r.published_date.clone(),
                rank: r.rrf as i64,
            })
            .collect();
        rows.push(measure(q, "METASEARCH-CYCLE", qi, ms, &as_raw, &fake));
    }
    rows
}

fn p(v: &[u64], frac: f64) -> u64 {
    if v.is_empty() {
        return 0;
    }
    let i = ((v.len() as f64 - 1.0) * frac).round() as usize;
    v[i]
}

fn summarize(name: &str, rows: &[&Row]) {
    let total = rows.len();
    let attempted: Vec<&Row> = rows.iter().copied().filter(|r| r.attempts > 0).collect();
    let skipped = total - attempted.len();
    let zeros = attempted.iter().filter(|r| r.n == 0).count();
    let nonempty = attempted.iter().filter(|r| r.n > 0).count();
    let mut ms: Vec<u64> = attempted.iter().map(|r| r.ms).collect();
    ms.sort();
    let sum: usize = attempted.iter().map(|r| r.n).sum();
    let rel: usize = attempted.iter().map(|r| r.relevant).sum();
    let dated: usize = attempted.iter().map(|r| r.dated).sum();
    let atem: usize = attempted.iter().map(|r| r.attempts).sum();
    let a403: usize = attempted.iter().map(|r| r.statuses.matches("403x").count()).sum();
    let a429: usize = attempted.iter().map(|r| r.statuses.matches("429x").count()).sum();
    let a0: usize = attempted.iter().map(|r| r.statuses.matches("0x").count()).sum();
    let n = attempted.len().max(1);
    println!(
        "{name:18} calls={total} skipped={skipped} attempted={} zero={zeros} success={nonempty} \
         p50={}ms p95={}ms avg_results={:.1} rel%={:.0} fresh%={:.0} attempts={atem} 403={a403} 429={a429} dead={a0}",
        attempted.len(),
        p(&ms, 0.50),
        p(&ms, 0.95),
        sum as f64 / n as f64,
        100.0 * rel as f64 / sum.max(1) as f64,
        100.0 * dated as f64 / sum.max(1) as f64,
    );
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("ruke_websearch=info".parse().unwrap()),
        )
        .with_target(false)
        .init();

    let out_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "engine-bench.csv".to_string());

    let engines: Vec<(&'static str, EngineFn)> = vec![
        ("duckduckgo", ddg_search),
        ("ddg-lite", ddg_lite_post),
        ("google", google_search),
        ("bing", bing_search),
        ("yahoo", yahoo_search),
        ("brave", brave_search),
        ("reddit", reddit_search),
        ("bing-news", bing_news_rss_search),
        ("github", github_search),
        ("devto", dev_to_search),
        ("wikipedia", wikipedia_search),
        ("hackernews", hackernews_search),
        ("arxiv", arxiv_search),
        ("stackexchange", stack_exchange_search),
        ("wikidata", wikidata_search),
        ("semantic-scholar", semantic_scholar_search),
        ("imdb", imdb_suggestion_search),
    ];

    println!("=== phase 1: per-engine x {} queries (engines parallel, queries sequential) ===", QUERIES.len());
    let t_all = Instant::now();
    let handles: Vec<_> = engines
        .iter()
        .map(|(name, f)| {
            let (name, f) = (*name, *f);
            tokio::spawn(async move { bench_engine(name, f, QUERIES).await })
        })
        .collect();
    let mut all: Vec<Row> = Vec::new();
    for h in handles {
        all.extend(h.await.unwrap());
    }
    println!("phase-1 wall={}s", t_all.elapsed().as_secs());
    for (name, _) in &engines {
        summarize(name, &all.iter().filter(|r| r.engine == *name).collect::<Vec<_>>());
    }

    println!("=== phase 2: metasearch() cycle x 12 mixed queries ===");
    let cycle_qs: &[&str] = &[
        "what is the capital of australia",
        "rust vs go backend performance",
        "tokio select cancel child task on drop",
        "spacex starship launch news",
        "steam deck vs asus ally x review",
        "attention is all you need paper",
        "reddit best hobby cnc router beginner",
        "satya nadella linkedin",
        "site:reddit.com homelab nas recommendation",
        "when does daylight saving time end in europe 2026",
        "best standing desk under 500",
        "latest stable linux kernel release notes",
    ];
    let cyc = bench_metasearch_cycle(cycle_qs).await;
    for r in &cyc {
        println!("cycle q=\"{}\" ms={} results={}", cycle_qs[r.qi], r.ms, r.n);
        summarize("metasearch-cycle", &[r]);
    }

    // CSV dump (rows serialized manually; no csv dep).
    let mut w = String::new();
    w.push_str("engine,qi,ms,n,uniq_domains,dup_ratio,relevant,dated,attempts,statuses\n");
    for r in all.iter().chain(cyc.iter()) {
        w.push_str(&format!(
            "{},{},{},{},{},{:.2},{},{},{},\"{}\"\n",
            r.engine, r.qi, r.ms, r.n, r.uniq_domains, r.dup_ratio, r.relevant, r.dated, r.attempts, r.statuses
        ));
    }
    std::fs::write(&out_path, w).expect("write csv");
    println!("wrote {}", out_path);
}
