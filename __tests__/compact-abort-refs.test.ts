import { describe, it, expect, afterEach, vi } from "vitest";
import {
  compactConversation,
  compactAttachmentStub,
  type CompactMessage,
} from "../lib/chat/compact";

/**
 * I28 (caller-owned cancellation) + I04 (structured evidence survives the
 * replacement) at the pipeline level. No model, no network: /api/chat is a
 * stub stream. The two contracts proven here:
 *
 *  1. A cancelled or truncated compaction NEVER promotes a partial
 *     <compacted_context> — the replacement stays the original history.
 *     (ChatClient resolves normally on abort, so the old code happily
 *     promoted whatever partial summary had streamed so far.)
 *  2. The replacement keeps structured attachment stubs: slim indexed stubs
 *     on the compacted-context message (deduped, capped, indexed-only for
 *     folded refs — the server re-retrieves their evidence), and per-tail
 *     stubs with RAW content and client-only media dropped.
 */

const enc = new TextEncoder();

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

function stubCompleteStream(contentChunks: string[]): void {
  const wire =
    contentChunks.map((c) => frame({ choices: [{ delta: { content: c } }] })).join("") +
    frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
    "data: [DONE]\n\n";
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(wire));
      c.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ),
  );
}

function history(withAtts = true): CompactMessage[] {
  const attA = {
    id: "msg0att", indexId: "att_a", name: "big.pdf", kind: "file",
    mime: "application/pdf", size: 100, status: "complete", indexed: true,
    category: "document", blobKey: "b_a", spine: "# TOC", text: "X".repeat(5000),
  };
  const dupA = { ...attA, id: "msg1att" };
  const note = { id: "n1", name: "note.txt", kind: "file", mime: "text/plain", size: 5, status: "complete", text: "folded note text" };
  const img = {
    id: "n2", name: "pic.png", kind: "image", mime: "image/png", size: 9, status: "complete",
    category: "image", text: "caption text", dataUrl: "data:image/png;base64,AAAA",
    previewUrl: "blob:http://x/1", frames: [{ at: 1, dataUrl: "data:image/png;base64,BB" }],
  };
  const attB = {
    id: "msg4att", indexId: "att_b", name: "clip.mp4", kind: "file", mime: "video/mp4",
    size: 10, status: "complete", indexed: true, category: "video", transcript: "T".repeat(3000),
  };
  return [
    { role: "user", content: "q1", ...(withAtts ? { attachments: [attA, note] } : {}) },
    { role: "assistant", content: "a1", ...(withAtts ? { attachments: [dupA] } : {}) },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "q3", ...(withAtts ? { attachments: [attB] } : {}) },
    { role: "assistant", content: "a3", ...(withAtts ? { attachments: [img] } : {}) },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compactConversation — cancellation guard (I28)", () => {
  it("aborted mid-stream never promotes a partial <compacted_context>", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, req: any) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(frame({
            choices: [{ delta: { content: "<compacted_context>\n## PARTIAL_SUMMARY" } }],
          })));
        },
        pull() {
          return new Promise<void>((_resolve, reject) => {
            const sig = req?.signal as AbortSignal | undefined;
            if (sig?.aborted) {
              reject(new DOMException("The operation was aborted.", "AbortError"));
              return;
            }
            sig?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted.", "AbortError")),
              { once: true },
            );
          });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }));

    const msgs = history();
    const p = compactConversation(msgs, { signal: ctrl.signal, tailSize: 2 });
    await new Promise((r) => setTimeout(r, 30)); // let the partial frame be delivered
    ctrl.abort();
    const res = await p;

    expect(res.ok).toBe(false);
    expect(res.compacted).toBe(false);
    expect(res.context).toBe("");
    expect(res.label).toBe("Compaction cancelled");
    expect(res.error).toBe("compaction cancelled by caller");
    const joined = JSON.stringify(res.replacementLlmMessages);
    expect(joined).not.toContain("PARTIAL_SUMMARY");
    expect(res.replacementLlmMessages.length).toBe(msgs.length); // original history kept
  });

  it("a pre-aborted signal short-circuits without promoting anything", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, req: any) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          if (req?.signal?.aborted) {
            c.error(new DOMException("The operation was aborted.", "AbortError"));
          }
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }));
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await compactConversation(history(), { signal: ctrl.signal, tailSize: 2 });
    expect(res.compacted).toBe(false);
    expect(res.label).toBe("Compaction cancelled");
  });

  it("a truncated compaction stream (EOF, no finish) reports failure, not a partial promotion", async () => {
    // Parser's honest truncation event (finishReason "error") makes the
    // pipeline's callback throw — the fold must be abandoned entirely.
    const wire =
      frame({ choices: [{ delta: { content: "<compacted_context>\n## PARTIAL_TRUNC" } }] }) +
      frame({ choices: [{ delta: { content: "…cut here" } }] }); // EOF right after, no finish/[DONE]
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(wire));
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      ),
    );
    const res = await compactConversation(history(), { tailSize: 2 });
    expect(res.ok).toBe(false);
    expect(res.compacted).toBe(false);
    expect(JSON.stringify(res.replacementLlmMessages)).not.toContain("PARTIAL_TRUNC");
  });
});

describe("compactConversation — structured evidence in the replacement (I04)", () => {
  it("compacted message carries slim deduped indexed stubs; tail keeps raw-content stubs", async () => {
    stubCompleteStream(["<compacted_context>\n## 1\n- rule kept\n", "</compacted_context>"]);
    const res = await compactConversation(history());
    expect(res.ok).toBe(true);
    expect(res.compacted).toBe(true);
    expect(res.context).toContain("rule kept");

    const repl = res.replacementLlmMessages;
    expect(repl.length).toBe(1 + 4); // one compacted message + the 4-message tail

    // The compacted-context message: only the deduped folded INDEXED stub —
    // heavy text dropped, spine/blobKey kept for retrieval.
    const refs = repl[0].attachments ?? [];
    expect(refs.length).toBe(1);
    expect(refs[0]).toMatchObject({ indexId: "att_a", name: "big.pdf", blobKey: "b_a", spine: "# TOC", indexed: true });
    expect(refs[0]).not.toHaveProperty("text");
    expect(refs[0]).not.toHaveProperty("transcript");

    // Tail stubs: raw content (client re-flattens — no double-send), no
    // client-only media, indexed tail stubs slim.
    const tail = repl.slice(1);
    expect(tail.map((m) => m.content)).toEqual(["q2", "a2", "q3", "a3"]);
    const q3 = tail[2];
    expect(q3.attachments?.length).toBe(1);
    expect(q3.attachments?.[0]).toMatchObject({ indexId: "att_b", name: "clip.mp4", indexed: true });
    expect(q3.attachments?.[0]).not.toHaveProperty("transcript");
    const a3 = tail[3];
    expect(a3.attachments?.[0]).toMatchObject({ id: "n2", name: "pic.png", text: "caption text" });
    expect(a3.attachments?.[0]).not.toHaveProperty("dataUrl");
    expect(a3.attachments?.[0]).not.toHaveProperty("previewUrl");
    expect(a3.attachments?.[0]).not.toHaveProperty("frames");
  });

  it("no attachments anywhere -> replacement is pure wire-shaped messages", async () => {
    stubCompleteStream(["<compacted_context>\n## 1\n- x\n</compacted_context>"]);
    const res = await compactConversation(history(false));
    expect(res.ok).toBe(true);
    for (const m of res.replacementLlmMessages) {
      expect(m).not.toHaveProperty("attachments");
      expect(typeof m.content).toBe("string");
    }
  });

  it("dedupes folded refs and caps at the 12-stub budget (newest kept)", async () => {
    const atts = [];
    for (let i = 1; i <= 15; i++) {
      atts.push({
        id: "a" + i, indexId: "att_" + i, name: "f" + i + ".pdf", kind: "file",
        mime: "application/pdf", size: 1, status: "complete", indexed: true,
      });
    }
    atts.push({ ...atts[2], id: "a3dup" }); // duplicate identity -> dropped
    const msgs: CompactMessage[] = [
      { role: "user", content: "big upload", attachments: atts },
      { role: "assistant", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "c" },
    ];
    stubCompleteStream(["<compacted_context>\nok\n</compacted_context>"]);
    const res = await compactConversation(msgs, { tailSize: 2 });
    const refs = res.replacementLlmMessages[0].attachments ?? [];
    expect(refs.length).toBe(12);
    expect(refs.map((r) => r.indexId)).toEqual(
      Array.from({ length: 12 }, (_, i) => "att_" + (i + 4)),
    ); // att_4..att_15 — oldest dropped first
  });
});

describe("compactAttachmentStub", () => {
  it("rejects empty/identity-less entries", () => {
    expect(compactAttachmentStub(null as any)).toBeNull();
    expect(compactAttachmentStub({})).toBeNull();
  });

  it("indexed entries slim to the reference surface", () => {
    const stub = compactAttachmentStub({
      id: "x", indexId: "att_x", name: "n.pdf", kind: "file", mime: "m", size: 2,
      status: "complete", indexed: true, text: "huge", transcript: "huge", frames: [1],
    });
    expect(stub).toMatchObject({ id: "x", indexId: "att_x", indexed: true });
    expect(stub).not.toHaveProperty("text");
    expect(stub).not.toHaveProperty("frames");
  });

  it("non-indexed entries keep text but drop client-only media", () => {
    const stub = compactAttachmentStub({
      id: "y", name: "p.png", category: "image", text: "t",
      dataUrl: "data:...", previewUrl: "blob:...", frames: [1],
    });
    expect(stub).toMatchObject({ id: "y", text: "t" });
    expect(stub).not.toHaveProperty("dataUrl");
    expect(stub).not.toHaveProperty("previewUrl");
    expect(stub).not.toHaveProperty("frames");
  });
});
