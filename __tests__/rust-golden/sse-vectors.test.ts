/**
 * Golden corpus — SSE transport vectors (MIGRATION-MAP §6 items: frames split
 * across arbitrary chunks, UTF-8 code points split across chunks, <think>
 * tags split at EVERY byte position incl. unterminated).
 *
 * Recorded through the LEGACY (stream:false) path so the response body is the
 * scrubbed upstream bytes with ZERO stage-frame noise.
 *
 * Transport chunk boundaries are NOT the contract for normal traffic — the
 * logical frames are (fixture 01 proves byte-identity). BUT the current TS
 * <think> scrubber DOES depend on chunk boundaries (it decodes+scrubs each
 * chunk independently — a known bug). The matrices in 02/03 pin the buggy TS
 * output per split position AND give the expected-Rust atomic-model output:
 * the Rust incremental state machine is the APPROVED DEVIATION (MIGRATION-MAP
 * "think bug" row, Rule 4). Production TS is NOT touched.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import {
  MOCK_LLM_KEY,
  MOCK_LLM_URL,
  UpstreamScript,
  bytesRecord,
  installUpstream,
  parseLogical,
  runChat,
  setGoldenEnv,
  thinkScrubAtomicModel,
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

  it("02 <think> tag split at EVERY byte position (approved-deviation matrix)", async () => {
    // Raw upstream byte stream: one frame whose content carries color markup +
    // one complete <think> block + one UNTERMINATED <think> at the very end.
    const F = 'data: {"id":"t1","choices":[{"index":0,"delta":{"content":"<font color=\'red\'>A</font><think>secret1</think>B<think>oops"}}]}\n\n';
    const S = F + DONE_FRAME;
    const expectedRust = thinkScrubAtomicModel(S);

    const cases: Record<string, unknown>[] = [];
    for (let i = 1; i < S.length; i++) {
      const run = await runLegacy([S.slice(0, i), S.slice(i)]);
      const out = run.text;
      cases.push({
        splitAtByte: i,
        tsOutput: out,
        expectedRust,
        tsMatchesExpectedRust: out === expectedRust,
      });
    }
    const mismatchBytes = cases.filter((c) => !c.tsMatchesExpectedRust).map((c) => c.splitAtByte as number);

    writeJsonFixture("sse/02-think-split-matrix.json", {
      upstreamStream: S,
      atomicExpectedRust: expectedRust,
      splitCount: cases.length,
      mismatchSplitBytes: mismatchBytes,
      cases,
    }, {
      scenario: "<think>/</think> split at every byte position (incl. unterminated block)",
      semantics:
        "tsOutput = the CURRENT TS scrubber's byte-for-byte output when the upstream stream is cut at " +
        "byte splitAtByte (two chunks): the scrubber decodes+scrubs EACH CHUNK INDEPENDENTLY, so a tag " +
        "straddling the boundary is not recognized (its halves leak through) and an unterminated block " +
        "only drops the remainder OF ITS OWN CHUNK. expectedRust = single-pass scrub of the whole stream " +
        "(atomic model): a split tag is still removed; an unterminated block drops everything from the " +
        "open tag onward. Rust must reproduce expectedRust for ALL splits.",
      comparison: "approved-deviation",
      harness: HARNESS,
      env: ENV_PRE,
      normalization: "none",
      notes:
        "This is the ONE place where chunk boundaries ARE behavior: it documents the known TS scrubber " +
        "bug (MIGRATION-MAP 'think bug' row) and defines the Rust state-machine target (approved fix, " +
        "Rule 4). The client-side lib/stream/thinkTags.ts is a separate TS-side filter and stays TS.",
    });

    // Contract sanity: every split strictly INSIDE a tag occurrence must mismatch
    // (the tag is broken, so neither half is recognized).
    const tagSpans: [number, number][] = [];
    for (const tag of ["<think>", "</think>"]) {
      let at = S.indexOf(tag);
      while (at !== -1) { tagSpans.push([at, at + tag.length]); at = S.indexOf(tag, at + tag.length); }
    }
    const insideTag = (i: number) => tagSpans.some(([s, e]) => i > s && i < e);
    for (const c of cases) {
      if (insideTag(c.splitAtByte as number)) expect(c.tsMatchesExpectedRust).toBe(false);
    }
    expect(mismatchBytes.length).toBeGreaterThan(0);
  });

  it("03 UTF-8 code points split across chunks", async () => {
    const F = 'data: {"id":"u1","choices":[{"index":0,"delta":{"content":"héllo 🎉"}}]}\n\n';
    const U = F + DONE_FRAME;
    const enc = new TextEncoder();
    const bytes = enc.encode(U);

    const cases: Record<string, unknown>[] = [];
    for (let i = 1; i < bytes.length; i++) {
      const run = await runLegacy([bytes.slice(0, i), bytes.slice(i)]);
      const rec = bytesRecord(run.bytes);
      cases.push({
        splitAtByte: i,
        cutsMidCodePoint: (bytes[i] & 0xc0) === 0x80,
        tsOutput: rec,
        expectedRustUtf8: U, // proper streaming decode => byte-identical passthrough
        tsIsByteIdentical: Buffer.compare(Buffer.from(run.bytes), Buffer.from(U, "utf8")) === 0,
      });
    }
    const mangledBytes = cases.filter((c) => !c.tsIsByteIdentical).map((c) => c.splitAtByte as number);
    const midCodePoint = (i: number) => (bytes[i] & 0xc0) === 0x80;

    writeJsonFixture("sse/03-utf8-split-matrix.json", {
      upstreamStreamUtf8: U,
      upstreamBytesBase64: Buffer.from(bytes).toString("base64"),
      splitCount: cases.length,
      mangledSplitBytes: mangledBytes,
      cases,
    }, {
      scenario: "UTF-8 multi-byte sequences split across upstream chunks",
      semantics:
        "CURRENT TS: each chunk is decoded with a FRESH TextDecoder, so a split inside a multi-byte " +
        "sequence emits U+FFFD and the response bytes are MANGLED (base64 kept per case). expectedRust: " +
        "one streaming decoder => the response bytes must be byte-identical to the upstream for EVERY " +
        "split. mangledSplitBytes lists exactly the mid-code-point positions.",
      comparison: "approved-deviation",
      harness: HARNESS,
      env: ENV_PRE,
      normalization: "none",
      notes:
        "Rust target: the proxy decode loop must use a single incremental TextDecoder (or byte-level " +
        "forwarding) — never a fresh decoder per chunk. This is the fixture proving the fix is required.",
    });

    for (const c of cases) {
      expect(c.tsIsByteIdentical).toBe(!midCodePoint(c.splitAtByte as number));
    }
  });
});
