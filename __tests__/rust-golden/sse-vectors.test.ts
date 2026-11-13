/**
 * Golden corpus — SSE transport vectors (MIGRATION-MAP §6 items: frames split
 * across arbitrary chunks, UTF-8 code points split across chunks, <think>
 * handling split at EVERY position incl. unterminated).
 *
 * Recorded through the LEGACY (stream:false) path so the response body is the
 * upstream bytes with ZERO stage-frame noise.
 *
 * 2026-11-13 brief §2 law (SUPERSEDES the old "approved-deviation" framing —
 * fixture shape changed, see docs/STATE.md 2026-11-13):
 * - The transport NEVER decodes or rewrites bytes. Response bytes are
 *   byte-identical to the upstream stream at EVERY chunk boundary, including
 *   splits inside multi-byte code points (fixture 03 pins this; the pre-fix
 *   per-chunk TextDecoder emitted U+FFFD at mid-code-point splits — FIXED,
 *   `mangledSplitBytes` must be empty).
 * - `<think>` routing is a FIELD-level law: the stateful splitter (TS
 *   `lib/stream/thinkTags.ts` ⇔ Rust `chat/scrubber.rs ThinkFieldSplitter`)
 *   scans already-parsed `delta.content` pieces and never depends on where
 *   network boundaries fell. Fixture 02 records cross-engine chunk vectors
 *   (pieces + expected {content, reasoning}) that
 *   `crates/ruke-server/tests/scrubber_vectors.rs` replays in Rust; think
 *   text routes to the reasoning channel and an unterminated tail SURVIVES
 *   (the retired scrubber deleted it — that behavior is gone for both
 *   engines).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { createThinkSplitter } from "@/lib/stream/thinkTags";
import {
  MOCK_LLM_KEY,
  MOCK_LLM_URL,
  UpstreamScript,
  bytesRecord,
  installUpstream,
  parseLogical,
  runChat,
  setGoldenEnv,
  writeJsonFixture,
} from "./support/golden";

setGoldenEnv();

vi.mock("@/lib/server/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/settings")>();
  return {
    ...actual,
    llmApiUrl: () => MOCK_LLM_URL,
    llmApiKey: () => MOCK_LLM_KEY,
  };
});

// Loaded AFTER setGoldenEnv() via beforeAll (route module must not import under a
// stale env); top-level await would trip tsc (tsconfig target es2015 => TS1378).
let POST: (req: NextRequest) => Promise<Response>;
beforeAll(async () => { POST = (await import("@/app/api/chat/route")).POST; });

const HARNESS = "__tests__/rust-golden/sse-vectors.test.ts";
const ENV_PRE = { WEB_SEARCH_GATE_DISABLED: "1", settings_llm_override: MOCK_LLM_URL };

const DONE_FRAME = "data: [DONE]\n\n";

function legacyBody(): string {
  return JSON.stringify({ model: "strata-mock", stream: false, messages: [{ role: "user", content: "sse vectors" }] });
}

async function runLegacy(chunks: (string | Uint8Array)[]) {
  installUpstream([{ chunks }]);
  return runChat(POST as never, legacyBody());
}

describe("golden: sse transport vectors", () => {
  it("01 frames split across arbitrary chunk boundaries", async () => {
    const F = 'data: {"id":"s1","choices":[{"index":0,"delta":{"content":"AB"}}]}\n\n';

    const cases = [
      { name: "mid-payload split", chunks: [F.slice(0, 20), F.slice(20), DONE_FRAME] },
      { name: "split between the two frame-terminator newlines", chunks: [F.slice(0, F.length - 1), "\n" + DONE_FRAME] },
      { name: "three-way split of one frame", chunks: [F.slice(0, 5), F.slice(5, 40), F.slice(40) + DONE_FRAME] },
      { name: "stray blank line between frames (extra \\n | \\n)", chunks: [F + "\n", "\n" + DONE_FRAME] },
      { name: "unterminated trailing frame (no terminator at all)", chunks: ['data: {"partial":true}'] },
    ];

    const recorded = [];
    for (const c of cases) {
      const run = await runLegacy(c.chunks);
      const logical = parseLogical(run.text);
      recorded.push({
        name: c.name,
        upstreamChunks: c.chunks.map((ch) => (typeof ch === "string" ? ch : "")),
        responseByteIdentity: run.text === c.chunks.map((ch) => (typeof ch === "string" ? ch : new TextDecoder().decode(ch))).join(""),
        response: bytesRecord(run.bytes),
        logicalFrames: logical.frames,
        streamDone: logical.done,
        unterminatedTail: logical.tail,
      });
    }

    writeJsonFixture("sse/01-frame-split-boundaries.json", { cases: recorded }, {
      scenario: "SSE frames split across arbitrary upstream chunk boundaries",
      semantics:
        "The route forwards upstream bytes without re-framing, so response bytes === concatenated chunk " +
        "bytes for EVERY boundary (byte identity proven per case). An unterminated trailing frame is " +
        "passed through as a partial tail: no [DONE] is synthesized and the tail stays unterminated.",
      comparison: "byte-exact",
      harness: HARNESS,
      env: ENV_PRE,
      normalization: "none",
      notes: "Transport boundaries are explicitly NOT the contract; re-parsed logical frames must be equal across all boundary cases (proven here).",
    });

    const nonTail = recorded.slice(0, 4);
    for (const r of nonTail) expect(r.responseByteIdentity).toBe(true);
    expect(recorded[4].unterminatedTail).toBe('data: {"partial":true}');
    expect(recorded[4].streamDone).toBe(false);
    // Every complete-frame case re-parses to the SAME logical frames regardless of boundary.
    const perCase = nonTail.map((r) => JSON.stringify(r.logicalFrames));
    expect(new Set(perCase).size).toBe(1);
  });

  it("02 <think> field-split matrix (cross-engine chunk vectors)", async () => {
    // The splitter consumes PARSED delta.content pieces — network chunk
    // boundaries never reach it (fixture 03 pins the raw transport instead).
    // Matrix: every 2-piece re-framing of each text must route IDENTICALLY to
    // the atomic single-piece run (chunking invariance), across scripts and
    // an UNTERMINATED trailing <think> (the class the retired scrubber
    // silently DELETED — now it survives as reasoning).
    // BMP-only texts: a char-index split must never cut a UTF-16 surrogate
    // pair (a lone half is not expressible in JSON — serde_json rejects it).
    // Non-BMP transport coverage lives in fixture 03's BYTE matrix instead.
    const TEXTS = [
      "<font color='red'>A</font><think>secret1</think>B<think>oops",
      "héllo తెలుగు <think>నిరీక్ష</think>end",
    ];

    function feedPieces(pieces: string[]): { content: string; reasoning: string } {
      const s = createThinkSplitter();
      let content = "", reasoning = "";
      for (const p of pieces) {
        const o = s(p);
        content += o.content;
        reasoning += o.reasoning;
      }
      const f = s.flush();
      return { content: content + f.content, reasoning: reasoning + f.reasoning };
    }

    const cases: Record<string, unknown>[] = [];
    const mismatchSplitChars: number[] = [];
    for (const text of TEXTS) {
      const atomic = feedPieces([text]);
      for (let i = 0; i <= text.length; i++) {
        const pieces = [text.slice(0, i), text.slice(i)];
        const got = feedPieces(pieces);
        const match = got.content === atomic.content && got.reasoning === atomic.reasoning;
        if (!match) mismatchSplitChars.push(i);
        cases.push({ text, splitAtChar: i, pieces, expected: atomic, replayMatchesAtomic: match });
      }
    }
    // Multi-piece framings that cut the delimiters themselves across pieces.
    const multi = ["<thi", "nk>SECRET", "</th", "ink>FINAL"];
    const multiExpected = feedPieces([multi.join("")]);
    const multiGot = feedPieces(multi);
    cases.push({
      text: multi.join(""), splitAtChar: -1, pieces: multi, expected: multiExpected,
      replayMatchesAtomic: multiGot.content === multiExpected.content && multiGot.reasoning === multiExpected.reasoning,
    });

    writeJsonFixture("sse/02-think-split-matrix.json", {
      texts: TEXTS,
      splitCount: cases.length,
      mismatchSplitChars,
      cases,
    }, {
      scenario: "<think>/</think> routing under EVERY re-framing of the content-field pieces (incl. unterminated block, non-Latin scripts)",
      semantics:
        "pieces = the delta.content slices a single text arrives as (splitAtChar = boundary; -1 = the " +
        "hand-written multi-piece delimiter framing). expected = atomic single-piece routing. Routing is " +
        "CONTENT-scoped, so every re-framing must equal the atomic result: mismatchSplitChars must be " +
        "EMPTY (chunking-invariance law). Think text lands in `reasoning`; an unterminated tail SURVIVES " +
        "there (the pre-2026-11-13 scrubber deleted it — retired).",
      comparison: "semantic",
      harness: HARNESS,
      env: ENV_PRE,
      normalization: "none",
      notes:
        "Shape changed 2026-11-13 (brief §2): the old byte-level upstreamStream/expectedRust scrub " +
        "matrices are gone with ThinkScrubber. Rust replays each case through ThinkFieldSplitter " +
        "(crates/ruke-server/tests/scrubber_vectors.rs). Texts are BMP-only: char-index slices must " +
        "never split a surrogate pair (a lone half cannot be serialized in JSON); non-BMP coverage is " +
        "pinned at BYTE level in fixture 03.",
    });

    expect(mismatchSplitChars).toEqual([]);
    const a0 = feedPieces([TEXTS[0]]);
    expect(a0.content).toBe("<font color='red'>A</font>B");
    expect(a0.reasoning).toBe("secret1oops"); // unterminated tail SURVIVES (old bug: deleted)
    expect(multiExpected.content).toBe("FINAL");
    expect(multiExpected.reasoning).toBe("SECRET");
  });

  it("03 UTF-8 code points split across chunks (raw transport, byte identity)", async () => {
    // 2026-11-13 brief §2: the transport never decodes, so a split inside a
    // multi-byte sequence must change NOTHING. The pre-fix per-chunk
    // TextDecoder emitted U+FFFD at these splits — this matrix now pins the
    // FIXED behavior: mangledSplitBytes must be EMPTY.
    const F = 'data: {"id":"u1","choices":[{"index":0,"delta":{"content":"héllo 🎉 తెలుగు"}}]}\n\n';
    const U = F + DONE_FRAME;
    const enc = new TextEncoder();
    const bytes = enc.encode(U);

    const cases: Record<string, unknown>[] = [];
    for (let i = 1; i < bytes.length; i++) {
      const run = await runLegacy([bytes.slice(0, i), bytes.slice(i)]);
      cases.push({
        splitAtByte: i,
        cutsMidCodePoint: (bytes[i] & 0xc0) === 0x80,
        responseBytes: bytesRecord(run.bytes),
        byteIdenticalToUpstream: Buffer.compare(Buffer.from(run.bytes), Buffer.from(U, "utf8")) === 0,
      });
    }
    const mangledBytes = cases.filter((c) => !c.byteIdenticalToUpstream).map((c) => c.splitAtByte as number);
    const midCount = cases.filter((c) => c.cutsMidCodePoint).length;

    writeJsonFixture("sse/03-utf8-split-matrix.json", {
      upstreamStreamUtf8: U,
      upstreamBytesBase64: Buffer.from(bytes).toString("base64"),
      splitCount: cases.length,
      midCodePointSplits: midCount,
      mangledSplitBytes: mangledBytes,
      cases,
    }, {
      scenario: "UTF-8 multi-byte sequences split across upstream chunks — RAW transport",
      semantics:
        "The route forwards RAW bytes (no decode, no rewrite — 2026-11-13 brief §2), so for EVERY split, " +
        "including cuts strictly inside a multi-byte code point, the response bytes are byte-identical to " +
        "the upstream. mangledSplitBytes must be EMPTY; the pre-fix per-chunk TextDecoder produced " +
        "U+FFFD at exactly the cutsMidCodePoint positions.",
      comparison: "byte-exact",
      harness: HARNESS,
      env: ENV_PRE,
      normalization: "none",
      notes:
        "Shape changed 2026-11-13: the old matrix recorded the bug per split (tsOutput vs expectedRustUtf8); " +
        "the fix landed in BOTH engines (route.ts raw pipe ⇔ Rust forward pumps), so the matrix now pins " +
        "identity. Rust parity: the same split replay lives in browser_loop.rs relay unit tests.",
    });

    expect(mangledBytes).toEqual([]);
    expect(midCount).toBeGreaterThan(0);
    for (const c of cases) expect(c.byteIdenticalToUpstream).toBe(true);
  });
});
