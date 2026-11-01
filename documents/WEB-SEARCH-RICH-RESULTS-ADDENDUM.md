# RUKE — UNIVERSAL RICH RESULTS / CHATGPT-CLASS IN-CHAT UI ADDENDUM

Status: LOCKED ADDENDUM to the P1–P7 plan (received 2026-11-02, mid-P6). It does NOT renumber phases and does NOT change execution order:

CURRENT execution remains: P6 → P3 → P2 → P4 → P5 → P7. P1 remains complete. Do NOT restart the implementation. Finish P6 exactly as planned.

Phase binding of this addendum:
- P3: preserve structured result metadata
- P2: tool/result envelopes
- P4: choose appropriate presentation type (presentation router)
- P5: implement the universal rich-result UI (together with the existing citation/search UI requirements)
- P7: final deterministic + locked Playwright proof (add the rich-UI scenarios from §79)

The existing Playwright exclusivity rule remains unchanged (§78).

---

# 1. WHY THIS ADDENDUM EXISTS

The current P5 plan focuses primarily on: citation pills, sources panel, cards, domain chips, verification badges, citation tooltips, search timeline, consulted-source list, clock widget, source counters, activity labels, source lightbox. Those are required but NOT sufficient.

Modern ChatGPT-style conversation UI can surface the actual result directly inside chat: images, video, YouTube, maps, businesses, weather, finance, sports, news, products, shopping comparisons, restaurant availability, interactive tables, charts, trackers, rich entities, application widgets, learning modules.

Ruke should not force the user to open ten browser tabs when the result can safely and usefully appear directly inside the conversation.

# 2. ARCHITECTURAL LAW — DO NOT HARDCODE SITES

DO NOT build YouTubeCard / ReutersCard / AmazonCard / ZomatoCard / ESPNCard / WikipediaCard as unrelated site-specific systems. Build ONE universal structured-result protocol.

Conceptually:

```ts
type RichResultSurface =
  | "generic" | "sources" | "image_gallery" | "video" | "audio" | "map"
  | "local_business" | "weather" | "finance" | "sports" | "news"
  | "product" | "product_carousel" | "product_comparison" | "restaurant"
  | "reservation" | "job" | "event" | "tracker" | "entity" | "table"
  | "chart" | "metrics" | "timeline" | "flashcards" | "quiz"
  | "simulation" | "file" | "app";
```

Use one versioned result envelope:

```ts
interface RichResult {
  id: string;
  version: 1;
  kind: RichResultSurface;
  title?: string;
  subtitle?: string;
  sourceRefs: string[];
  payload: unknown;
  actions?: RichAction[];
  presentation?: { preferred: "inline" | "carousel" | "grid" | "fullscreen" | "pip" };
}
```

Actual schemas must be Zod-validated. Rust must have equivalent serde contracts where backend semantics cross the Rust boundary. Unknown future kinds MUST gracefully fall back to a generic result card. Never crash the conversation because the frontend does not recognize a future surface.

# 3. CRITICAL LAW — STRUCTURED DATA DRIVES UI

The MODEL MUST NOT fabricate frontend UI through Markdown.

Bad: model outputs "here is a weather card", or invents JSON in Markdown and the frontend trusts it.

Correct: tool/retriever → validated structured result → RichResult envelope → frontend renderer.

The model may explain the result in prose. It does NOT get to invent: prices, ratings, map coordinates, weather values, sports scores, reservation times, stock prices, source metadata. Those must come from tool/retrieval evidence.

# 4. KEEP ARTIFACTS SEPARATE FROM WEB RESULTS

`components/render/FenceRouter.tsx` is the MODEL-OUTPUT / ARTIFACT renderer (Mermaid, Chart, Widget, Tree, HTML, Resume, DOCX, XLSX, PPTX, PowerBI, 3D, CAD, Anatomy, code). DO NOT overload FenceRouter with the web-results system. Create a parallel architecture such as `components/web-results/` (or the equivalent best existing project location): RichResultRenderer, RichResultRegistry, RichResultFrame, RichResultActions, RichResultErrorBoundary — then renderer families underneath. Artifact fences and retrieved web results are different trust domains. Keep them separate.

# 5. UNIVERSAL BASE PRIMITIVES

Build reusable primitives first: ResultCard, ResultCarousel, ResultGrid, ResultList, ResultTable, ResultChart, ResultMap, ResultMedia, ResultTimeline, ResultMetric, ResultGallery, ResultSheet, ResultLightbox, ResultActions, ResultSkeleton, ResultError. Do not duplicate layout code in every vertical.

# 6. IMAGE SEARCH / IMAGE RESULTS

Implement ImageResultGrid, ImageResultCarousel, ImageLightbox. Each image carries: image URL, thumbnail, source page, source domain, caption if known, dimensions if known, sourceRef. Interactions: click → lightbox; previous/next; open source; copy source URL; fullscreen. NEVER display a web image with no source provenance. Do not hotlink giant original files when a safe thumbnail exists. Lazy-load images. Use responsive `srcset` when available.

# 7. YOUTUBE / VIDEO

Major missing surface. The backend ALREADY has significant YouTube extraction infrastructure (`lib/web-search/youtube.ts`, youtubei.js, transcripts, chapters, comments, metadata). P5 should actually SURFACE the video. Implement VideoResult, YouTubeResult. For valid public YouTube results show: thumbnail, title, channel, duration, publish date if known, play button, chapter markers when known, source link. On Play: render a safe inline YouTube player. Prefer privacy-enhanced embedding where practical. Do not autoplay. Do not fake playback. Do not proxy or circumvent YouTube access controls. If embedding is unavailable: fall back to thumbnail + "Open on YouTube".

# 8. VIDEO DISPLAY MODES

inline, fullscreen, PiP. PiP is useful when the user continues talking while watching. Do not force PiP automatically. User initiates playback/display expansion. Remember playback position while the component remains mounted where practical.

# 9. GENERAL WEB VIDEO

Support a generic VideoResult for legitimate public playable media when MIME/URL is known. Use native `<video>` only for supported safe URLs. Never treat arbitrary HTML as video. Fallback: preview card → open source.

# 10. AUDIO / PODCAST

Add AudioResult: play/pause, seek, duration, current timestamp, speed, title, source, optional transcript toggle. If transcript evidence contains timestamps, clicking the timestamp may seek to that time. Never autoplay.

# 11. MAPS

Implement a true reusable MapResult: single location, multiple pins, selected pin, fit bounds, zoom, fullscreen. Each location: id, name, lat, lon, address, category, sourceRef. Do NOT use the model to invent coordinates. Coordinates must come from: structured place data, OSM/Nominatim, Maps extraction, another validated provider. The repository already contains Google Maps / OSM retrieval infrastructure. Use it.

# 12. LOCAL BUSINESS

Implement LocalBusinessCard, LocalBusinessList. Fields when actually known: name, category, rating, review count, price range, address, distance, hours, open/closed, phone, website, image, map coordinate. Never show unknown values as guessed values. Click business → select map pin / open detail sheet.

# 13. LOCATION RESULT CLUSTER

For restaurants / hotels / shops / attractions / cafes / services: prefer map + scrollable cards when there are several geographically related results. Do not render ten disconnected giant cards.

# 14. WEATHER

Implement WeatherResult. At minimum: location, current condition, temperature, feels-like if known, high/low, precipitation if known, wind if known, updated time. Expandable: hourly, multi-day. Do not use weather-style UI for stale generic webpage evidence. Only render from current structured/verified weather data.

# 15. FINANCE / STOCK

Implement FinanceQuote, FinanceCompare. Fields where available: symbol, company, price, currency, absolute change, percentage change, market status, updated time, sparkline/history. Comparison: multiple series, legend, period selector if backed by data. Always expose timestamp. Never imply stale cached data is live.

# 16. SPORTS

Create generic sports contracts rather than one sport per frontend architecture: ScoreCard, ScheduleCard, StandingsTable, TeamCard, PlayerCard, Bracket. Generic fields adapt by sport: teams, score, status, period/inning/set/quarter, clock, venue, date, competition. Use sport adapters behind a shared renderer.

# 17. NEWS

Implement NewsCard, NewsCarousel: publisher, headline, thumbnail, published time, short description, source. For a breaking-news cluster prefer multiple publishers. Do not turn every search result into news UI. Only when result intent is news/current-event oriented.

# 18. SHOPPING / PRODUCT DISCOVERY

Major missing ChatGPT-style surface. Implement ProductCard, ProductCarousel, ProductComparison. Fields only when verified: image, title, brand, price, currency, merchant, rating, review count, availability, shipping, key attributes, product URL. Do not mix ads with organic product results. If Ruke later supports sponsorship, that must be a separate explicitly-labelled system.

# 19. PRODUCT CAROUSEL

Multiple products → horizontally scrollable carousel. Compact cards. Do NOT create huge vertical cards that make five results take five screens. Support previous/next, keyboard navigation, touch swipe, open product, compare.

# 20. PRODUCT COMPARISON

For explicit "A vs B" or a small shortlist: ProductComparisonTable. Rows: price, key specs, reviews, advantages, disadvantages, availability. Only show attributes that can be fairly compared. Missing values = "—". Never hallucinate equivalence.

# 21. SHOPPING IMAGE DISCOVERY

If a shopping result includes meaningful visual choices: product image gallery, similar-item action. Architecture should leave room for future image-to-product retrieval. Do not make image generation or virtual try-on a blocker for P5.

# 22. RESTAURANTS

Add RestaurantCard, RestaurantCarousel, RestaurantDetail. Possible verified fields: cuisine, rating, review count, price level, address, distance, opening hours, images, menu link, map.

# 23. RESERVATION UI

Design a provider-neutral ReservationSlots (e.g. 6:30 PM / 7:00 PM / 7:30 PM / 8:00 PM). Reservation actions are CONSEQUENTIAL. Never book automatically. Selection can prepare the action. The actual booking/submit must follow the P6 authorization rules.

# 24. JOB RESULTS

Implement JobCard, JobList. Fields where known: company, title, location, remote/hybrid/on-site, salary, posted date, employment type, source. Expandable description. Open original job. Do NOT submit applications automatically from a result card.

# 25. EVENT RESULTS

Implement EventCard, EventCarousel: title, date/time, venue, city, image, ticket source, status. Can integrate with MapResult.

# 26. MOVIES / TV / ARTISTS / ENTERTAINMENT

Implement generic MediaEntityCard, UpcomingList. Fields: poster/image, title/name, release date, runtime, rating if sourced, platform/venue, upcoming appearances/releases, source. Do not create site-specific IMDb UI.

# 27. TRACKING

Create generic TrackerResult for flight / package / other status journeys. Render: current state, last update, timeline, next expected state. Never fake real-time status.

# 28. GENERIC ENTITY

Implement EntityCard, EntityDetail for person / company / organization / place / product / movie / artist / team. Common shell: image, name, type, summary, key facts, sourceRefs, related actions. Domain-specific renderer may enhance it; the generic renderer remains the fallback.

# 29. INTERACTIVE TABLES

Current MarkdownTable exists — do NOT throw it away. Upgrade structured-result tables where useful with: sort, column resize, horizontal scroll, sticky header, fullscreen, copy, download CSV. Only add filtering where it helps. Keep ordinary Markdown tables lightweight.

# 30. INTERACTIVE CHARTS

Current ChartBlock exists — reuse its chart engine. Structured web/data results should be able to invoke it WITHOUT the model fabricating a chart fence. Support at least: line, bar, area, scatter, pie/donut where appropriate. Interactive: tooltip, legend, hover, fullscreen. No decorative charts without meaningful data.

# 31. METRIC / STAT CARDS

Implement compact MetricCard, MetricRow for verified numbers (price, temperature, score, percentage, distance, duration). A metric always needs units/context.

# 32. SEARCH / SOURCE SURFACES (existing P5 requirements remain mandatory)

citation pill, source tooltip, source preview, Sources panel, source card, domain chip, consulted-source list, claim status, search timeline, per-host counter, activity label, source lightbox.

# 33. IMAGE / SOURCE LIGHTBOX

Create ONE reusable Lightbox capable of presenting: image, source preview, document preview, rich entity detail. Do not create different modal systems for every renderer.

# 34. FULLSCREEN RESULT SHEET

Create ResultFullscreen (map, large chart, large table, image gallery, video, comparison, interactive app). Esc closes. Focus must be trapped/accessibly restored. Composer/chat state must not be lost.

# 35. PICTURE-IN-PICTURE

Architectural support for video (and audio/live session if useful). Do not build a generic floating window for every result. PiP is for persistent ongoing content.

# 36. FLASHCARDS

Implement generic FlashcardDeck: flip, know, missed, next, previous, shuffle, progress. Not web-search-specific, but belongs in the universal rich-surface architecture. Content still follows normal model/evidence rules.

# 37. QUIZ

Implement QuizResult: single/multiple choice, answer, next, score, explanation. Do not reveal the correct answer before submission unless requested.

# 38. INTERACTIVE LEARNING / SIMULATION

Create a generic safe SimulationResult for math/science-style modules. Potential controls: slider, numeric input, toggle, graph, formula display. Do not implement 70 hardcoded topics. Build a schema-driven simulation primitive.

# 39. GENERIC INTERACTIVE APP WIDGET

Ruke already has WidgetBlock and HtmlArtifactBlock, but retrieved/tool-driven widgets need a distinct trust boundary. Implement a sandboxed AppResult supporting inline / fullscreen / optional PiP with a strict capability/action bridge. Do not let arbitrary retrieved HTML execute as an AppResult. Only trusted locally generated/registered component code may execute.

# 40. RESULT ACTION BRIDGE

Define validated actions:

```ts
type RichAction =
  | { type: "open_source"; url: string }
  | { type: "open_detail"; targetId: string }
  | { type: "lightbox"; targetId: string }
  | { type: "fullscreen"; targetId: string }
  | { type: "pip"; targetId: string }
  | { type: "issue_followup"; prompt: string }
  | { type: "compare"; ids: string[] }
  | { type: "select_map_pin"; id: string }
  | { type: "seek_media"; seconds: number }
  | { type: "prepare_action"; actionId: string };
```

Validate every action. Never execute an arbitrary URL/javascript action sent by the model.

# 41. CONSEQUENTIAL ACTION BOUNDARY

A rich result can expose Reserve / Buy / Apply / Book / Send / Upload ONLY as an action entry point. P6 still controls execution. The UI must distinguish read/navigation vs consequential action. Never cause purchase/application/reservation merely by rendering a card.

# 42. PROVENANCE LAW

Every web-derived rich result MUST carry `sourceRefs`, and every important factual field must trace to evidence. Example: product price carries `price.value` / `price.sourceRef` / `price.retrievedAt`; weather carries `temperature.sourceRef` / `observedAt`; sports carries `score.sourceRef` / `updatedAt`. A rich card is NOT permission to lower citation quality.

# 43. STALE-DATA INDICATOR

For time-sensitive components show "Updated 2 min ago" / "Updated today" / "Cached" where appropriate. If live data was requested but only stale evidence exists, say that visually. Never make stale cached data look live.

# 44. LOADING / SKELETON

Professional neutral skeletons. NO rainbow shimmer, NO purple-blue AI glow, NO gradient sweep. Prefer neutral block + subtle opacity pulse. Skeleton structure should approximately match final result geometry to reduce layout shift.

# 45. ABSOLUTELY NO "AI UI" AESTHETIC (HARD USER REQUIREMENT)

DO NOT use: purple→blue gradients, cyan→violet gradients, rainbow gradients, neon borders, glowing cards, glowing icons, excessive glassmorphism, giant blurred colored blobs, holographic styling, "AI sparkle" decoration everywhere, animated gradient borders, colorful gradient text, luminous cyan status bars, decorative color simply because the feature is AI-generated. Ruke must look like a serious professional application.

# 46. VISUAL LANGUAGE

Restrained ChatGPT-like visual language: neutral, clean, dense when useful, quiet, content-first. Prefer existing Ruke theme tokens. Dark treatment: near-black/charcoal main background; slightly lighter neutral raised surface; another subtle neutral level; near-white primary text; neutral gray secondary text; quieter gray muted metadata; low-contrast neutral border. Do NOT blindly hardcode exact ChatGPT colors — use Ruke's own CSS variables/theme system.

# 47. ACCENT COLORS

Color must have MEANING: green → success/positive; amber → warning/partial; red → failure/negative; blue → link/selected informational state. Use sparingly. Source/merchant/team logos may retain natural brand color INSIDE the logo/image. Do not recolor the whole card to match a source brand.

# 48. CARDS

Subtle border, small radius, neutral background, minimal/no shadow, clear hierarchy, comfortable padding. Avoid oversized floating cards, thick glowing outlines, big gradients, huge drop shadows.

# 49. TYPOGRAPHY

Use the existing application font stack. Hierarchy comes primarily from size, weight, spacing — not rainbow colors. Keep metadata compact. Do not make every card title gigantic.

# 50. MOTION

Functional motion only: approximately 120–200 ms for ordinary hover/expand/carousel transition/sheet opening. No bouncing AI blobs. No continuous decorative motion. Respect `prefers-reduced-motion`.

# 51. RESPONSIVENESS

Every surface must work at desktop, tablet, mobile. Carousels become touch-scrollable. Tables scroll horizontally. Map height adapts. Cards stack intelligently. No result should force page-wide horizontal overflow.

# 52. ACCESSIBILITY

All interactive results require keyboard access, visible focus, ARIA label, semantic role, screen-reader text where necessary, contrast, Esc close for overlays, focus restoration. Carousel buttons must have meaningful labels. Images need alt/caption when known.

# 53. DO NOT VISUALLY SPAM THE CHAT

Rich UI is conditional: use it only when it improves understanding, comparison, navigation or interaction. "Who invented the telephone?" → plain answer + citation, NOT a giant entity dashboard. "Restaurants around Hyderabad" → business cards + map. "RTX 5060 vs 5070 prices" → product comparison. "Show me this YouTube video" → inline video. "Weather tomorrow" → weather card. The presentation router decides.

# 54. ONE PRIMARY RICH SURFACE BY DEFAULT

Avoid stacking map + gallery + carousel + table + chart + cards in one answer unnecessarily. Normally choose ONE primary surface. Additional surfaces only when information is genuinely distinct/useful.

# 55. PRESENTATION ROUTER (P4)

```ts
interface PresentationPlan {
  primary: "text" | "images" | "video" | "map" | "weather" | "finance"
    | "sports" | "news" | "shopping" | "business" | "reservation" | "jobs"
    | "events" | "tracker" | "entity" | "table" | "chart" | "learning" | "app";
  layout: "inline" | "carousel" | "grid" | "map_split" | "table" | "fullscreen_capable";
  reason: string;
}
```

Do not require an additional expensive LLM call solely for presentation if the deterministic result type already tells us the answer.

# 56. STRUCTURED SOURCE ROUTING

When P2/P3/P4 have structured results, preserve them: YouTube evidence → video result; geocoded places → map/local business; weather provider → weather result; stock provider → finance result; sports provider → sports result; product metadata → product result; news cluster → news result. Do not flatten structured data into prose and then try to reconstruct it on the client.

# 57. STREAMING

RichResult events must integrate with existing `ruke_stage` / `web:*` / `web_meta` without breaking existing clients. The answer may stream while a rich result progressively appears. Do NOT wait for the entire answer before displaying already-validated structured results.

# 58. STREAM EVENT EXAMPLE

Extend the existing event architecture additively: `web:surface_discovered`, `web:surface_ready`, `web:surface_updated`. Payload: surface id, kind, revision. Do not stream enormous payloads repeatedly. Send state revisions/deltas where appropriate.

# 59. RESULT STATE

Surfaces support: loading, ready, stale, partial, error. One broken widget must not destroy the assistant response. Error surface: "Couldn't load interactive view / Open source", with normal prose still intact.

# 60. SECURITY

P6 safety rules apply to every rich surface. Never execute retrieved scripts, retrieved event handlers, retrieved HTML apps, or model-generated javascript as trusted web-result UI. Remote web content is DATA. Trusted renderer code is LOCAL.

# 61. EXTERNAL EMBEDS

Every embed must use an explicit allowlist (e.g. YouTube, approved video providers). Do not render arbitrary iframe origins from search results. Use CSP/sandbox restrictions.

# 62. PERFORMANCE

Do not put all rich renderers in the initial bundle. Follow existing Ruke law: `next/dynamic` + `ssr: false` for heavy surfaces — particularly maps, video, large gallery, finance chart, sports complex UI, interactive app. Do not make ordinary text chat pay the cost.

# 63. IMAGE PERFORMANCE

Lazy loading, thumbnail first, responsive image sizes, bounded decode. Do not pull 50 full-resolution images into one chat turn.

# 64. MAP PERFORMANCE

Lazy-load the map runtime only when a MapResult mounts. Do not put Leaflet/MapLibre/etc. in the initial chat bundle. Choose the smallest viable local/open solution after inspecting existing dependencies. Avoid adding a giant dependency if the existing stack can solve it.

# 65. MEDIA PERFORMANCE

Video iframe/player does not mount until visible or the user presses Play. No autoplay. Suspend/pause off-screen where appropriate.

# 66. DO NOT REGRESS CURRENT ARTIFACT FEATURES

Existing develop already has: ChartBlock, WidgetBlock, MarkdownTable, MermaidBlock, TreeBlock, CodeBlock, HtmlArtifactBlock, ResumeBlock, DocxBlock, XlsxBlock, PptxBlock, PowerBiBlock, Scene3DBlock, Asset3DBlock, ThreeCodeBlock, CadBlock, AnatomyBlock. Keep them. Web Rich Results integrate with them only when logically appropriate. Do not rewrite these merely to satisfy P5.

# 67. P5 COMPLETION REQUIRES THESE CORE SURFACES

CORE: CitationPill, CitationPreview, SourcesPanel, SourceCard, SearchTimeline, ImageGallery, ImageLightbox, VideoResult, YouTubeResult, AudioResult, MapResult, LocalBusinessCard, WeatherResult, FinanceQuote, SportsResult, NewsResult, ProductCard, ProductCarousel, ProductComparison, RestaurantCard, ReservationSlots, JobCard, EventCard, TrackerResult, EntityCard, InteractiveTable, InteractiveChart, MetricCard, ResultCarousel, ResultGrid, ResultFullscreen, ResultLightbox, ResultError.

These are universal surface families. Do not build every possible niche-specific widget before P7. Build generic contracts so specialized domains can compose them.

# 68. SECONDARY INTERACTIVE SURFACES

Also provide architecture/support for: FlashcardDeck, QuizResult, SimulationResult, AppResult. Implement them in P5 if the primitive architecture makes them reasonable without destabilizing the core search work. At minimum their schemas/registry extension path must be clean.

# 69. P5 IS NOT COMPLETE IF YOUTUBE IS STILL ONLY A LINK

Given a valid public YouTube source already understood by the Ruke YouTube evidence layer: show thumbnail, title, channel, duration, play, source directly in chat. The user should not need to open another browser merely to watch it.

# 70. P5 IS NOT COMPLETE IF LOCAL RESULTS ARE ONLY LINKS

Multiple local businesses: cards + map when geospatial data is available.

# 71. P5 IS NOT COMPLETE IF SHOPPING IS ONLY TEXT

Multiple products → visual cards/carousel. Explicit comparison → comparison table.

# 72. P5 IS NOT COMPLETE IF IMAGES ARE JUST URLS

Image search → gallery/carousel + lightbox + source attribution.

# 73. P5 IS NOT COMPLETE IF LIVE DATA LOOKS LIKE ORDINARY MARKDOWN

Weather / stocks / sports / tracking → compact structured cards when reliable structured data exists. Still provide textual explanation around the component.

# 74. DETERMINISTIC COMPONENT TESTS BEFORE PLAYWRIGHT

Test renderer logic with fixture RichResult payloads. No local model needed. Required fixture classes: image gallery, youtube, audio, map, local business, weather, finance, sports, news, products, comparison, restaurant, reservation, job, event, tracker, entity, table, chart, error.

# 75. CONTRACT TESTS

Reject: invalid URLs, javascript: URLs, unallowlisted iframe domains, missing IDs, invalid coordinates, NaN numeric values, bad action types, oversized unsafe payloads. Gracefully fall back.

# 76. VISUAL STYLE TESTS

Add regressions proving rich-result components do NOT contain: linear-gradient, radial-gradient, conic-gradient, neon-glow classes, animated gradient classes — unless an existing non-web artifact explicitly requires them for its own authored content. For the new universal web-results system: GRADIENTS ARE FORBIDDEN.

# 77. ACCESSIBILITY TESTS

Verify: keyboard navigation, focus restoration, ARIA names, carousel controls, lightbox Esc, fullscreen Esc, media controls.

# 78. FINAL PLAYWRIGHT — STILL LAST

DO NOT run Playwright now. The locked order remains: finish P6 → P3 → P2 → P4 → P5 → all deterministic tests → benchmarks → final exclusive Playwright loop. When final Playwright starts: Claude Code performs ZERO other work until Playwright fully exits. Follow `.ai-coordination/playwright.lock` and `CLAUDE.md` exactly.

# 79. FINAL PLAYWRIGHT RICH-UI SCENARIOS

Add representative coverage, not one test per internet site. Must prove: YouTube inline player/card; image search gallery/lightbox; local business map + cards; weather card; news carousel/card; product carousel; product comparison; citation pill → exact source; rich surface fallback when data malformed; no gradient/neon visual regressions. If structured sports/finance providers are available by P7, include one representative live scenario for each. Do NOT make an unavailable third-party live endpoint block deterministic component proof.

# 80. COMPLETION LAW

The goal is NOT "we copied 25 ChatGPT widgets." The goal is: "Ruke now has a universal structured rich-result platform capable of rendering ChatGPT-class visual and interactive results from any provider without site-specific frontend hacks." A new provider should normally require: adapter + structured payload — NOT brand-new chat architecture. That is the universal-level acceptance criterion.

# 81. DO NOT STOP CURRENT WORK

Currently in P6 — continue P6. Do NOT implement the P5 UI prematurely. While implementing P2/P3/P4: preserve enough structured metadata for this P5 system. When P5 begins: implement this addendum together with the existing P5 citation/search UI requirements. Then continue to P7 under the existing one-shot/shutdown plan. Do not ask for confirmation between phases.
