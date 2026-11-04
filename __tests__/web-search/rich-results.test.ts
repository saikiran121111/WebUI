/**
 * P5 rich-results protocol suite (Addendum §74–§77).
 *
 * Deterministic: NO browser, NO local model — fixture RichResult payloads
 * straight into the producer/sanitizer/renderers. The four producer pins
 * below were BYTE-IDENTICAL to the Rust parity pins in
 * rust-backend/crates/ruke-websearch/src/rich_results.rs — that mirror was
 * removed in the 2026-11-03 TS rollback; these pins are the sole owner.
 */
import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RICH_RESULT_KINDS, MAX_PAYLOAD_BYTES, RichResultSchema,
  isSafeHttpUrl, sanitizeRichResult, deriveRichResults,
  type GeoPoint, type RichResult,
} from "../../lib/web-search/rich-results";
import type { EvidencePacket, RankedResult } from "../../lib/web-search/types";
import type { PresentationPlan } from "../../lib/web-search/presentation";
import { renderSurface } from "../../components/web-results/RichResultRegistry";
import { CitationPill } from "../../components/web-results/CitationPreview";
import { SourcesPanel } from "../../components/web-results/SourcesPanel";
import { ResultError } from "../../components/web-results/ResultChrome";
import { RichResultsBlock } from "../../components/web-results/RichResultRenderer";

// ── fixtures (mirror the Rust fixture builders verbatim) ────────────────

const ranked = (url: string, domain: string, title: string): RankedResult => ({
  url, canonical: url, title, snippet: "", engine: "test", domain,
  rrf: 1, engines: ["test"], engineRanks: { test: 1 },
});

const packet = (
  sourceId: string, url: string, domain: string, title: string, passageText: string,
): EvidencePacket => ({
  sourceId, url, title, domain, extraction: "direct",
  passages: passageText
    ? [{ sourceId, url, title, domain, passageText, bm25Score: 1 }]
    : [],
  classification: "SUCCESS_DIRECT",
});

const pl = (
  primary: PresentationPlan["primary"], layout: PresentationPlan["layout"],
): PresentationPlan => ({ primary, layout, reason: "fixture" });

/** Fixture envelopes must pass the §75 walker, else the fixture is wrong. */
const env = (raw: Record<string, unknown>): RichResult => {
  const r = sanitizeRichResult(raw);
  if (!r) throw new Error("fixture must sanitize: " + JSON.stringify(raw));
  return r;
};

const render = (surface: RichResult): string =>
  renderToString(renderSurface(surface) as never);

// ── §2 protocol vocabulary ──────────────────────────────────────────────

describe("protocol vocabulary (§2)", () => {
  it("declares exactly the 29 locked kinds in serde order", () => {
    expect(RICH_RESULT_KINDS).toHaveLength(29);
    expect(RICH_RESULT_KINDS[0]).toBe("generic");
    expect(RICH_RESULT_KINDS[28]).toBe("app");
  });

  it("RichResultSchema is strict — unknown keys are rejected", () => {
    const ok = RichResultSchema.safeParse({
      id: "x", version: 1, kind: "generic", sourceRefs: [], payload: {},
    });
    expect(ok.success).toBe(true);
    expect(RichResultSchema.safeParse({
      id: "x", version: 1, kind: "generic", sourceRefs: [], payload: {}, hacked: 1,
    }).success).toBe(false);
  });
});

// ── §75 sanitizer reject matrix (byte pins ⇔ Rust) ──────────────────────

describe("sanitizeRichResult (§75)", () => {
  it("drops: missing id, empty id, unknown version, oversized payload", () => {
    expect(sanitizeRichResult({ kind: "map" })).toBeNull();
    expect(sanitizeRichResult({ id: "", kind: "map" })).toBeNull();
    expect(sanitizeRichResult({ id: "x", version: 2, kind: "map" })).toBeNull();
    expect(sanitizeRichResult({
      id: "x", kind: "map", payload: { big: "x".repeat(70_000) },
    })).toBeNull();
    expect(MAX_PAYLOAD_BYTES).toBe(65_536);
  });

  it("javascript: URL dropped under a url-ish key; payload survives", () => {
    const r = sanitizeRichResult({
      id: "x", kind: "map", payload: { url: "javascript:alert(1)", ok: 1 },
    });
    expect(JSON.stringify(r!.payload)).toBe('{"ok":1}');
  });

  it("invalid coordinate pair stripped, valid pair kept (75.0 ⇒ token 75)", () => {
    const r = sanitizeRichResult({
      id: "y", kind: "map",
      payload: { a: { lat: 999, lng: 0 }, b: { latitude: 12.5, longitude: 75.0 } },
    });
    expect(JSON.stringify(r!.payload)).toBe('{"a":{},"b":{"lat":12.5,"lng":75}}');
  });

  it("embed allowlist (§61): off-allowlist embed dropped, youtube-nocookie kept", () => {
    const r = sanitizeRichResult({
      id: "z", kind: "video",
      payload: { embed: "https://evil.example/embed", ok: "https://www.youtube-nocookie.com/embed/abc" },
    })!;
    expect((r.payload as Record<string, unknown>).embed).toBeUndefined();
    expect((r.payload as Record<string, unknown>).ok).toBeDefined();
  });

  it("unknown kind ⇒ generic card (§2), never a crash", () => {
    expect(sanitizeRichResult({ id: "k", kind: "holodeck", payload: {} })!.kind).toBe("generic");
  });

  it("bad actions dropped individually; bad presentation hint retried away", () => {
    const r = sanitizeRichResult({
      id: "a", kind: "video", payload: {},
      actions: [{ type: "hack" }, { type: "open_source", url: "https://ok.example/1" }],
      presentation: { preferred: "sideways" },
    })!;
    expect(JSON.stringify(r.actions)).toBe('[{"type":"open_source","url":"https://ok.example/1"}]');
    expect(r.presentation).toBeUndefined();
  });

  it("§40 action pins: canonical key order on the wire", () => {
    const r = sanitizeRichResult({
      id: "a1", kind: "video", sourceRefs: [], payload: {},
      actions: [
        { type: "seek_media", seconds: 5 },
        { type: "open_detail", targetId: "t1" },
        { type: "open_source", url: "https://ok.example/1" },
      ],
    })!;
    expect(JSON.stringify(r.actions)).toBe(
      '[{"type":"seek_media","seconds":5},{"type":"open_detail","targetId":"t1"},{"type":"open_source","url":"https://ok.example/1"}]',
    );
  });

  it("prototype-pollution keys stripped from payloads", () => {
    const r = sanitizeRichResult({
      id: "p", kind: "generic",
      payload: { __proto__: { a: 1 }, constructor: 2, kept: true },
    });
    expect(JSON.stringify(r!.payload)).toBe('{"kept":true}');
  });

  it(">12 actions ⇒ the whole envelope is dropped", () => {
    const acts = Array.from({ length: 13 }, (_, i) => ({ type: "open_detail", targetId: `t${i}` }));
    expect(sanitizeRichResult({ id: "n", kind: "generic", payload: {}, actions: acts })).toBeNull();
  });

  it("missing version defaults to 1", () => {
    expect(sanitizeRichResult({ id: "v", kind: "generic", payload: {} })!.version).toBe(1);
  });
});

describe("isSafeHttpUrl (§6/P6 law)", () => {
  it("accepts plain https, rejects everything smuggly", () => {
    expect(isSafeHttpUrl("https://ok.example/1")).toBe(true);
    for (const bad of [
      "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd",
      "http://localhost/x", "http://127.0.0.1/x", "http://[::1]/x",
      "http://foo.onion/x", "https://user:pw@ok.example/", "https://ok.example/a b",
      "not a url", "",
    ]) expect(isSafeHttpUrl(bad)).toBe(false);
  });
});

// ── Producer: pinned surfaces (byte parity with the Rust mirror) ────────

describe("deriveRichResults (producer, §3/§53/§54)", () => {
  it("video: YouTube evidence only, deduped, pinned wire bytes", () => {
    const got = deriveRichResults({
      plan: pl("video", "carousel"),
      results: [
        ranked("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube.com", "dup"),
        ranked("https://youtu.be/9bZkp7q19f0", "youtu.be", "Gangnam"),
        ranked("https://example.com/no", "example.com", "no"),
      ],
      packets: [packet("S1", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube.com", "Rick Astley", "")],
      geoPoints: [],
    });
    expect(got).toHaveLength(2);
    expect(JSON.stringify(got[0])).toBe(
      '{"id":"rich:video:dQw4w9WgXcQ","version":1,"kind":"video","title":"Rick Astley","sourceRefs":["S1"],"payload":{"videoId":"dQw4w9WgXcQ","url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","thumbnail":"https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"},"actions":[{"type":"open_source","url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}],"presentation":{"preferred":"carousel"}}',
    );
    expect(got[1].sourceRefs).toEqual(["youtu.be"]);
  });

  it("map: pins from validated geo evidence only, coords re-emitted last", () => {
    const geo: GeoPoint[] = [{
      id: "pin1", lat: 12.9152, lng: 77.5245, label: "India Gate",
      url: "https://maps.google.com/?q=India+Gate", sourceRef: "maps",
    }];
    const got = deriveRichResults({ plan: pl("map", "map_split"), results: [], packets: [], geoPoints: geo });
    expect(JSON.stringify(got[0])).toBe(
      '{"id":"rich:map","version":1,"kind":"map","sourceRefs":["maps"],"payload":{"pins":[{"id":"pin1","label":"India Gate","url":"https://maps.google.com/?q=India+Gate","lat":12.9152,"lng":77.5245}]},"actions":[{"type":"open_source","url":"https://maps.google.com/?q=India+Gate"}],"presentation":{"preferred":"inline"}}',
    );
  });

  it("news: news-domain ranked results only, pinned wire bytes", () => {
    const r1 = ranked("https://reuters.com/world/1", "reuters.com", "Summit ends");
    r1.publishedDate = "2026-11-01";
    const got = deriveRichResults({
      plan: pl("news", "grid"),
      results: [
        r1,
        ranked("https://reuters.com/world/1", "reuters.com", "dup"),
        ranked("https://randomblog.io/x", "randomblog.io", "off"),
        ranked("https://www.bbc.com/news/2", "bbc.com", "Broadcast"),
      ],
      packets: [], geoPoints: [],
    });
    expect(JSON.stringify(got[0])).toBe(
      '{"id":"rich:news","version":1,"kind":"news","title":"News","sourceRefs":["reuters.com","bbc.com"],"payload":{"items":[{"title":"Summit ends","url":"https://reuters.com/world/1","domain":"reuters.com","publishedAt":"2026-11-01"},{"title":"Broadcast","url":"https://www.bbc.com/news/2","domain":"bbc.com"}]},"presentation":{"preferred":"grid"}}',
    );
  });

  it("entity: the Wikipedia packet only, pinned wire bytes", () => {
    const got = deriveRichResults({
      plan: pl("entity", "inline"),
      results: [],
      packets: [
        packet("S1", "https://example.com/x", "example.com", "X", ""),
        packet("S2", "https://en.wikipedia.org/wiki/Telephone", "en.wikipedia.org", "Telephone", "The telephone invents sound."),
      ],
      geoPoints: [],
    });
    expect(JSON.stringify(got[0])).toBe(
      '{"id":"rich:entity:S2","version":1,"kind":"entity","title":"Telephone","subtitle":"en.wikipedia.org","sourceRefs":["S2"],"payload":{"url":"https://en.wikipedia.org/wiki/Telephone","description":"The telephone invents sound."},"actions":[{"type":"open_source","url":"https://en.wikipedia.org/wiki/Telephone"}],"presentation":{"preferred":"inline"}}',
    );
  });

  it("§53 honesty: weather primary with no weather tool emits NOTHING", () => {
    expect(deriveRichResults({
      plan: pl("weather", "inline"),
      results: [ranked("https://reuters.com/world/1", "reuters.com", "x")],
      packets: [], geoPoints: [],
    })).toEqual([]);
    expect(deriveRichResults({
      plan: null,
      results: [], packets: [],
      geoPoints: [{ id: "p", lat: 1, lng: 1 }],
    })).toEqual([]);
  });
});

// ── §74 component classes (fixture payloads → server-rendered markup) ──

describe("surface renderers (§74)", () => {
  it("image gallery: imgs with alt + credit, no iframe", () => {
    const html = render(env({
      id: "g1", kind: "image_gallery", sourceRefs: ["S1"],
      payload: { images: [{ url: "https://img.example/a.jpg", alt: "Mount Fuji", creditDomain: "img.example" }] },
    }));
    expect(html).toContain("wr-gallery");
    expect(html).toContain('alt="Mount Fuji"');
  });

  it("youtube: thumbnail card pre-play, NO third-party iframe mounted (§63)", () => {
    const html = render(env({
      id: "rich:video:dQw4w9WgXcQ", kind: "video", sourceRefs: ["S1"],
      payload: {
        videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", duration: 210,
      },
    }));
    expect(html).toContain("i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    expect(html).toContain("3:30");
    expect(html).not.toContain("/embed/");
  });

  it("youtube: malformed videoId falls back to a source card, never crashes", () => {
    const html = render(env({
      id: "rich:video:bad", kind: "video", sourceRefs: ["S1"],
      payload: { videoId: "BAD!!", url: "https://www.youtube.com/watch?v=x" },
    }));
    expect(html).not.toContain("hqdefault.jpg");
    expect(html).toContain("youtube.com");
  });

  it("audio: native player, metadata preload, no autoplay (§10)", () => {
    const html = render(env({
      id: "au", kind: "audio", sourceRefs: ["S1"],
      payload: { url: "https://audio.example/s.mp3", title: "Field recording" },
    }));
    expect(html).toContain("<audio");
    expect(html).toContain('preload="metadata"');
    expect(html).not.toContain("autoplay");
  });

  it("map: SSR-safe placeholder + always-visible pin list (§11)", () => {
    const html = render(env({
      id: "rich:map", kind: "map", sourceRefs: ["maps"],
      payload: { pins: [{ id: "pin1", label: "India Gate", url: "https://maps.google.com/?q=India+Gate", lat: 12.9152, lng: 77.5245 }] },
    }));
    expect(html).toContain("wr-map-placeholder");
    expect(html).toContain("India Gate");
    expect(html).toContain("OpenStreetMap");
    expect(html).not.toContain("<iframe"); // lazy-mount law: only once visible on-screen
  });

  it("local business: rating shown ONLY from payload (§12)", () => {
    const html = render(env({
      id: "lb", kind: "local_business", sourceRefs: ["S1"],
      payload: {
        items: [{ id: "b1", name: "Cafe Alpha", rating: 4.5, ratingCount: 120, cuisine: "Cafe", url: "https://maps.google.com/?q=Cafe+Alpha" }],
        pins: [{ id: "b1", lat: 12.9, lng: 77.5, label: "Cafe Alpha" }],
      },
    }));
    expect(html).toContain('data-testid="business-rating"');
    expect(html).toContain("4.5");
    expect(html).toContain("Cafe Alpha");
  });

  it("weather / finance / sports: structured values only", () => {
    const w = render(env({
      id: "wt", kind: "weather", sourceRefs: ["S1"],
      payload: { current: { temp: 28, unit: "C", desc: "Clear" }, items: [{ date: "Mon", hi: 31, lo: 20, desc: "Sunny" }] },
    }));
    expect(w).toContain('data-testid="weather-current"');
    expect(w).toContain("28");

    const f = render(env({
      id: "fn", kind: "finance", sourceRefs: ["S1"],
      payload: { symbol: "AAPL", price: 231.5, currency: "USD", change: 1.25, changePct: 0.54 },
    }));
    expect(f).toContain('data-testid="finance-price"');
    expect(f).toContain("wr-metric-delta--up");

    const s = render(env({
      id: "sp", kind: "sports", sourceRefs: ["S1"],
      payload: { status: "Final", home: { name: "Alpha", score: 3 }, away: { name: "Beta", score: 1 } },
    }));
    expect(s).toContain('data-testid="sports-scoreline"');
    expect(s).toContain("Alpha");
  });

  it("news: preferred layout picks grid vs carousel (§54/§51)", () => {
    const base = {
      id: "rich:news", kind: "news" as const, sourceRefs: ["reuters.com"],
      payload: { items: [{ title: "Summit ends", url: "https://reuters.com/world/1", domain: "reuters.com" }] },
    };
    expect(render(env(base))).not.toContain("aria-roledescription=\"carousel\"");
    expect(render(env({ ...base, presentation: { preferred: "carousel" } })))
      .toContain('aria-roledescription="carousel"');
  });

  it("products: single card vs carousel; comparison table fills gaps with —", () => {
    const one = render(env({
      id: "pr1", kind: "product", sourceRefs: ["S1"],
      payload: { items: [{ title: "Phone X", price: 699, currency: "USD" }] },
    }));
    expect(one).toContain("Phone X");

    const cmp = render(env({
      id: "cmp", kind: "product_comparison", sourceRefs: ["S1", "S2"],
      payload: {
        products: [{ name: "A", url: "https://a.example/x" }, { name: "B", url: "https://b.example/y" }],
        rows: [{ attribute: "Price", values: ["699", "799"] }, { attribute: "RAM", values: ["8"] }],
      },
    }));
    expect(cmp).toContain("wr-table");
    expect(cmp).toContain("—");
  });

  it("reservation slots: unavailable stays disabled — entry point only (§41)", () => {
    const html = render(env({
      id: "rs", kind: "reservation", sourceRefs: ["S1"],
      payload: { items: [{ id: "s1", time: "19:00", available: true }, { id: "s2", time: "20:30", available: false }] },
    }));
    expect(html).toContain("19:00");
    expect(html.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain("checkout");
  });

  it("job / event / tracker / entity: provenance-labelled rows", () => {
    expect(render(env({
      id: "jb", kind: "job", sourceRefs: ["S1"],
      payload: { items: [{ title: "Engineer", company: "Acme", location: "Remote" }] },
    }))).toContain("Engineer");

    expect(render(env({
      id: "ev", kind: "event", sourceRefs: ["S1"],
      payload: { items: [{ title: "Meetup", date: "2026-11-05", venue: "Hall" }] },
    }))).toContain("Meetup");

    expect(render(env({
      id: "tr", kind: "tracker", sourceRefs: ["S1"],
      payload: { status: "live", value: "7", unit: "days" },
    }))).toContain("live");

    const en = render(env({
      id: "ent", kind: "entity", sourceRefs: ["S2"],
      payload: { url: "https://en.wikipedia.org/wiki/Telephone", description: "The telephone.", items: [{ label: "Invented", value: "1876" }] },
    }));
    expect(en).toContain("1876");
    expect(en).toContain("wr-kv");
  });

  it("table / chart / timeline / metrics render from payload alone", () => {
    const t = render(env({
      id: "tb", kind: "table", sourceRefs: ["S1"],
      payload: { columns: ["City", "Pop"], rows: [["Delhi", "32M"]], caption: "Cap" },
    }));
    expect(t).toContain("<table");
    expect(t).toContain("Delhi");

    const c = render(env({
      id: "ch", kind: "chart", sourceRefs: ["S1"],
      payload: { type: "bar", labels: ["Jan", "Feb"], series: [{ name: "Sales", values: [1, 2] }] },
    }));
    expect(c).toContain("<svg");
    expect(c).toContain('role="img"');

    expect(render(env({
      id: "tl", kind: "timeline", sourceRefs: ["S1"],
      payload: { events: [{ date: "1876", label: "Patent filed" }] },
    }))).toContain("Patent filed");

    expect(render(env({
      id: "ms", kind: "metrics", sourceRefs: ["S1"],
      payload: { items: [{ label: "Uptime", value: 99.5, delta: 0.2 }] },
    }))).toContain("99.5");
  });

  it("flashcards / quiz / simulation: learning surfaces, local logic only (§36–38)", () => {
    const fc = render(env({
      id: "fc", kind: "flashcards", sourceRefs: ["S1"],
      payload: { cards: [{ front: "Q: Capital of France?", back: "Paris" }] },
    }));
    expect(fc).toContain('data-testid="flashcard"');
    expect(fc).toContain("Capital of France?");

    const q = render(env({
      id: "qz", kind: "quiz", sourceRefs: ["S1"],
      payload: { questions: [{ id: "q1", prompt: "2+2?", options: ["3", "4"], correctIndex: 1 }] },
    }));
    expect(q).toContain('role="radiogroup"');
    expect(q).toContain("2+2?");

    const sim = render(env({
      id: "sm", kind: "simulation", sourceRefs: ["S1"],
      payload: {
        variables: [{ id: "x", label: "X", min: 0, max: 10, default: 5 }],
        outputs: [{ label: "Y", base: 1, coefficients: { x: 2 } }],
      },
    }));
    expect(sim).toContain('data-testid="simulation-output"');
    expect(sim).toContain("11");
    expect(sim).not.toContain("<script"); // §39/§60: no code, arithmetic only
  });

  it("app surfaces never render raw retrieved HTML (§39)", () => {
    const html = render(env({
      id: "ap", kind: "app", sourceRefs: ["S1"],
      payload: { sections: [{ kind: "mystery-widget", payload: { html: "<script>alert(1)</script>" } }] },
    }));
    expect(html).toContain("wr-frame");
    expect(html).not.toContain("<script");
  });

  it("generic fallback: text + items; unknown kind lands here via sanitize", () => {
    const g = render(env({
      id: "gf", kind: "holodeck", sourceRefs: ["S1"],
      payload: { text: "Hello from the fixture", items: [{ title: "Row", url: "https://ok.example/1" }] },
    }));
    expect(g).toContain("Hello from the fixture");
    expect(g).toContain("Row");
  });

  it("§59: broken surface = ResultError escape hatch, never a dead message", () => {
    const html = renderToString(h(ResultError, { url: "https://ok.example/1" }));
    expect(html).toContain("Couldn’t load interactive view.");
    expect(html).toContain("Open source");
    expect(html).toContain('href="https://ok.example/1"');
  });

  it("§54: ONE primary surface inline, the rest behind chips", () => {
    const surfaces = [
      env({ id: "w1", kind: "weather", sourceRefs: ["S1"], payload: { current: { temp: 28, unit: "C", desc: "Clear" } } }),
      env({ id: "f1", kind: "finance", sourceRefs: ["S1"], payload: { symbol: "AAPL", price: 1, currency: "USD" } }),
    ];
    const html = renderToString(h(RichResultsBlock, { surfaces }));
    expect(html).toContain('data-testid="rich-results"');
    expect(html).toContain('data-testid="weather-current"'); // primary inline
    expect(html).not.toContain('data-testid="finance-price"'); // secondary = chip only
    expect(html).toContain("wr-secondary");
  });
});

// ── §77 accessibility contract ──────────────────────────────────────────

describe("a11y surfaces (§77)", () => {
  it("CitationPill keeps its DOM contract + hover/focus preview popover", () => {
    const html = renderToString(h(CitationPill, {
      sourceId: "S1", url: "https://reuters.com/world/1", title: "Summit ends",
      domain: "reuters.com", publishedAt: "2026-11-01",
    }));
    expect(html).toContain('data-testid="citation-pill"');
    expect(html).toContain('data-citation="S1"');
    expect(html).toContain('href="https://reuters.com/world/1"');
    expect(html).toContain('data-testid="citation-preview"');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("2026-11-01");
  });

  it("CitationPill never emits an unsafe href", () => {
    const html = renderToString(h(CitationPill, { sourceId: "S2", url: "javascript:alert(1)" }));
    expect(html).not.toContain('href="javascript:');
  });

  it("SourcesPanel groups by domain, cited sources first (U5)", () => {
    const html = renderToString(h(SourcesPanel, {
      citationMap: {
        S1: { sourceId: "S1", url: "https://reuters.com/world/1", title: "Summit ends", domain: "reuters.com" },
        S2: { sourceId: "S2", url: "https://www.bbc.com/news/2", title: "Broadcast", domain: "bbc.com" },
      },
      content: "as [S1] reported",
    }));
    expect(html).toContain('data-testid="sources-panel"');
    expect(html).toContain("wr-src-group");
    expect(html.indexOf("reuters.com")).toBeLessThan(html.indexOf("bbc.com"));
    expect(html).toContain('data-testid="source-card"');
  });

  it("frames are labelled regions; carousel buttons are named", () => {
    const html = render(env({
      id: "cn", kind: "news", sourceRefs: ["S1"],
      presentation: { preferred: "carousel" },
      payload: { items: [
        { title: "One", url: "https://reuters.com/a", domain: "reuters.com" },
        { title: "Two", url: "https://apnews.com/b", domain: "apnews.com" },
      ] },
    }));
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-roledescription="carousel"');
    expect(html).toContain('aria-label="Previous item"');
    expect(html).toContain('aria-label="Next item"');
  });
});

// ── §76 style regression law: NO "AI UI" aesthetic ─────────────────────

describe("style regression (§76)", () => {
  const HERE = fileURLToPath(new URL(".", import.meta.url));
  const CSS = path.resolve(HERE, "../../styles/web-results.css");
  const COMPONENTS_DIR = path.resolve(HERE, "../../components/web-results");

  it("web-results.css carries zero gradients/neon/animated sweeps", () => {
    // Scan DECLARATIONS only: the §45 law is itself written into a header
    // comment ("NO neon borders…") — comments stating the prohibition are
    // not style regressions. Strip /* */ blocks, then scan what renders.
    const css = readFileSync(CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/(linear|radial|conic)-gradient/i);
    expect(css).not.toMatch(/neon/i);
    expect(css).not.toMatch(/animated-gradient/i);
  });

  it("web-results components carry zero inline gradient styles", () => {
    for (const f of readdirSync(COMPONENTS_DIR)) {
      if (!/\.(ts|tsx)$/.test(f)) continue;
      const src = readFileSync(path.join(COMPONENTS_DIR, f), "utf8");
      expect(src, f).not.toMatch(/(linear|radial|conic)-gradient/i);
      expect(src, f).not.toMatch(/background-image:\s*url\(?data:image/i);
    }
  });
});
