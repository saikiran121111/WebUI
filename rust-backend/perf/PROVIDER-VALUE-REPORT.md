# Provider Value Report — engine benchmark BEFORE optimization

Run: `cargo run -p ruke-websearch --example engine_bench` (2026-10-29, this dev box's residential IP).
Raw data: `perf/engine-bench-20261029.csv` (row per engine×query), stdout summary in `perf/engine-bench-run.log`, lib traces interleaved in run.log (`engine outcome`, `search_one:`, `metasearch cycle complete`).

## Methodology & caveats

- 59 representative queries (factoid, dev, news, shopping, local, academic, forum, people, WAF-heavy, date-sensitive) × 17 engines.
- Engines run **in parallel** (own BenchNet ⇒ exact per-attempt HTTP histogram); queries sequential per engine ⇒ production pacing preserved. Per-call harness cap was **60 s** for this run (binary built before the cap was trimmed to 30 s).
- One pass. Breaker state is process-global, so early-call failures poison later calls for breaker-guarded engines (skipped = attempts-0 rows). **Raw capability** = stats over attempted calls; **production-effective** = including skips.
- `rel%` is a cheap proxy (result title+snippet shares ≥2 lowercased query tokens) — biased against terse-snippet engines (bing). Not an answer-quality measure.
- Wikimedia/Arxiv/Semantic-Scholar 429 storms are IP-reputation effects of un-paced vertical fan-out; on a different egress IP these engines may recover. The health layer must adapt at runtime; classifications below encode the guard, not a permanent blacklist.
- Summary-line `dead=` column was buggy (`"0x"` substring matched `"200x"`); true transport-dead counts below come from the corrected CSV histogram.

## True status histograms (from CSV)

```
duckduckgo 200x4 202x6            ddg-lite 202x69 403x24 0(transport)x21 200x4
google     200x59 (consent wall)  bing     200x59
yahoo      200x4 500x4            brave    200x5 429x2
reddit     200x111 429x54 403x6 404x6      bing-news 200x83
github     200x30 403x35 429x109 devto     200x2
wikipedia  200x15 429x90          wikidata 200x15 429x90
hackernews 200x59                 arxiv    200x20 429x78
stackexch  200x59                 sem-sch  200x3 429x113
imdb       200x59
```

## Per-engine results (n=59 calls each)

| engine | skipped | attempted | success | zero | p50 | p95 | avg res | rel% | verdict |
|---|---|---|---|---|---|---|---|---|---|
| bing | 0 | 59 | **59** | 0 | 401ms | 471ms | 9.7 | 16* | PRIMARY |
| bing-news | 0 | 59 | 50 | 9 | 547ms | 1066ms | 8.7 | 72, fresh100 | PRIMARY (news intent) |
| brave | 52 | 7 | 5 | 2 | 1717ms | 2584ms | 10.7 | 83 | SECONDARY |
| yahoo | 53 | 6 | 4 | 2 | 2093ms | 2482ms | 9.8 | 54 | SECONDARY |
| duckduckgo | 56 | 3 | 1 | 2 | 753ms | 1198ms | 3.3 | 100 | RECOVERY_ONLY |
| reddit | 0 | 59 | 53 | 6 | 3568ms | 9694ms | 12.1 | 35, fresh98 | SPECIALIST (forum intent only) |
| github | 0 | 59 | 13 | 46*zeros largely query-specific | 386ms | 1555ms | 1.7 | 32 | SPECIALIST (dev) |
| devto | 57 | 2 | 0 | 2 | 799ms | — | 0 | — | SPECIALIST(dev) guarded |
| hackernews | 0 | 59 | 16 | 43* | 679ms | 2366ms | 0.6 | 94, fresh100 | SPECIALIST (forum/news) |
| stackexchange | 0 | 59 | 11 | 48* | 310ms | 415ms | 0.9 | 80, fresh100 | SPECIALIST (dev/docs) |
| wikipedia | 0 | 59 | 12 | 47 | 2664ms | 3081ms | 0.7 | 100 | SPECIALIST, needs pacing |
| arxiv | 0 | 59 | 16 | 43* | 3034ms | 5988ms | 0.5 | 66 | SPECIALIST (academic), needs pacing |
| ddg-lite | 0 | 59 | 1 | **58** | 1113ms | 36051ms | 0.2 | — | DISABLED_BY_DEFAULT (202 challenge wall 69×, transport-dead 21×) |
| google | 0 | 59 | **0** | 59 | 367ms | 453ms | 0 | — | DISABLED_BY_DEFAULT (200 consent wall, 0 results 59×) |
| wikidata | 0 | 59 | **0** | 59 | 2661ms | 3077ms | 0 | — | DISABLED_BY_DEFAULT (0/59; wikipedia covers factoids) |
| semantic-scholar | 0 | 59 | 2 | 57 | 4283ms | 4730ms | 0.1 | 43 | DISABLED_BY_DEFAULT (429x113 self-throttled) |
| imdb | 0 | 59 | 2 | 57 | 498ms | 861ms | 0.1 | 0 | DISABLED_BY_DEFAULT (2/59, rel 0) |

\* zeros on verticals are mostly legitimate query-mismatches (they answered when the query matched); the 429s are the real signal.

## Code-level findings (verified against engines.rs)

1. **Breaker blind spot — google (engines.rs 1343-1357):** a 200-wall page with empty parses returns `Vec::new()` at L1357 having recorded **neither** `note_engine_success` **nor** `trip_circuit_breaker`. The breaker never engages ⇒ google burns 59/59 network round-trips. Same fall-through risk exists on any engine where `out.len() < 2 && res.ok && !is_blocked`.
2. **Unguarded engines:** `bing`, `reddit`, `bing-news` use the plain `engine_pacer` (no breaker) (L1796, 2005, 2101). **All seven metasearch verticals** (wikipedia, hackernews, arxiv, stack_exchange, wikidata, semantic_scholar, imdb) have **no pacer and no breaker at all** ⇒ unbounded fan-out produced 429x90 (wikipedia+wikidata share the limiter), 429x78 arxiv, 429x113 S2.
3. **Reddit sits in the general pool** (`GENERAL_WEB_ENGINES[6]`) against the "Reddit is intent-routed only" requirement — it contributed 177 attempts (429x54) to every general search while only forum queries benefit.
4. **The pool always starves:** all 12 phase-2 `metasearch()` cycles ran 10.5–12.2 s — the 10 s `SEARCH_ONE_CAP` fired every single time because the pool's wall is dominated by the dead/dying engines (google 0.4s wall, ddg-lite 202+6s, yahoo 500s) while the healthy ones (bing 0.4s, bing-news 0.55s) finish in the first second. **3/12 cycles kept 0 results** (incl. a dev query and both reddit-site queries) → downstream gap search fires a second full metasearch + 5-page read → the measured 30,395 ms first-content baseline.
5. `trip_circuit_breaker` currently treats a single zero as streak-only (correct — query-specific) but has no escalation: repeat trips recycle the same 60 s cooldown forever.

## Phase-2 metasearch() cycles (one plan, max_results=20)

```
capital of australia        11038ms  5 kept    reddit cnc router        10480ms  0 kept
rust vs go                  12243ms  9 kept    satya nadella linkedin   10656ms  5 kept
tokio select cancel         10608ms  0 kept    site:reddit homelab      10541ms  0 kept
spacex starship news        10610ms  5 kept    DST europe 2026          10863ms  5 kept
steam deck vs ally x        10756ms  5 kept    standing desk under 500  10649ms  1 kept
attention-is-all-you-need   10745ms  5 kept    linux kernel release     10826ms  4 kept
```

Target after surgery: cycles in the 2–5 s band with ≥5 kept results or an explicit starvation exit that fires recovery earlier (not after a wasted 10 s).

## Resulting routing changes to implement

- General pool = **bing, brave, yahoo, duckduckgo(html)** (order = value first); reddit/github removed.
- google + ddg-lite: kept implemented + wired but trip-fast via the fixed breaker (or env-disabled); not deleted (TS parity, different egress IPs may recover).
- wikidata, semantic_scholar, imdb: routed out of default intents; reachable via explicit intent only.
- All previously-unguarded engines/verticals get pacer+breaker; zero-with-200 counts as a zero observation (fixes #1); transport failure trips immediately (streak=2 rule retained for query-specific zeros).
