import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * PART 10: the ResponseAborted family through the REAL Rust-backed stack
 * (regression candidate A — the false "Rust backend unreachable"
 * classification fixed in 6e96b61 must NOT come back).
 *
 * These journeys use the browser's own fetch/AbortController and the real
 * title route, so the client disconnects are genuine browser aborts
 * travelling Next :3000 → Rust :3101 → Strata. The companion check (PHASE C,
 * manual) greps the supervisor log: a downstream cancellation must never
 * produce an "unreachable" proxy line.
 *
 * Model-backed: run only under the Playwright lock, workers:1.
 */

const BASE = "http://localhost:3000";

async function warmModel(request: APIRequestContext) {
  const res = await request.post(`${BASE}/api/chat`, {
    data: {
      model: "default",
      stream: false,
      messages: [{ role: "user", content: "Reply with exactly one word: ok" }],
    },
    timeout: 240_000,
  });
  expect(res.ok()).toBeTruthy();
}

async function seedConversation(request: APIRequestContext, id: string, opts: { title: string; titleSource?: "auto" | "manual"; firstContent?: string }) {
  const now = Date.now();
  const doc = {
    id,
    meta: {
      id,
      title: opts.title,
      ...(opts.titleSource ? { titleSource: opts.titleSource } : {}),
      createdAt: now,
      updatedAt: now,
      pinned: false,
      archived: false,
      mode: "chat",
      preview: "hello",
      messageCount: 1,
    },
    messages: [
      {
        id: "u_" + id, conversationId: id, role: "user",
        content: opts.firstContent ?? opts.title,
        reasoning: "", attachments: [], toolCalls: [], citations: [],
        createdAt: now, state: "complete", mode: "chat",
      },
    ],
  };
  const res = await request.post(`${BASE}/api/conversations`, { data: { id, json: JSON.stringify(doc) } });
  expect(res.ok()).toBeTruthy();
}

test.describe("ResponseAborted family (Rust-backed)", () => {
  test("client-aborted chat stream is a cancellation, not an unreachable backend", async ({ page, request }) => {
    test.setTimeout(300_000);
    await warmModel(request);

    // A long turn so the abort lands mid-stream, after bytes have arrived.
    const result = await page.evaluate(async () => {
      const ctrl = new AbortController();
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: "default",
          stream: true,
          messages: [{ role: "user", content: "Count out loud from one to one hundred, one number per line." }],
        }),
      });
      const reader = resp.body!.getReader();
      let bytes = 0;
      setTimeout(() => ctrl.abort(), 1500);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value?.length ?? 0;
        }
      } catch {
        /* abort surfaces here — expected */
      }
      return { status: resp.status, bytes };
    });

    // The server accepted the turn and streamed bytes BEFORE the cancel.
    expect(result.status).toBe(200);
    expect(result.bytes, "stream must have begun before the client cancelled").toBeGreaterThan(0);

    // The cancellation must not poison the seam: the very next turn works and
    // carries the Rust header ledger (x-decision-mode, emitted by the Rust
    // chat route on every response).
    const next = await request.post(`${BASE}/api/chat`, {
      data: { model: "default", stream: false, messages: [{ role: "user", content: "Reply with exactly one word: ok" }] },
      timeout: 240_000,
    });
    expect(next.ok(), "post-cancel turn must succeed (no wedged slot, no false unreachable)").toBeTruthy();
    expect(next.headers()["x-decision-mode"], "Rust chat responses carry x-decision-mode").toBeTruthy();
  });

  test("a title job abandoned by the client still lands (accept-then-hold)", async ({ request }) => {
    test.setTimeout(300_000);
    const id = "c_ttlabort_" + Date.now();
    const first =
      "My Home Assistant Zigbee mesh keeps dropping coordinator pairings every few days after the 2026.10 update, how do I stabilize it?";
    await seedConversation(request, id, { title: first.slice(0, 40), firstContent: first });

    // Abandon the request 2.5 s in: the title model call is slower than that,
    // so the client disconnects AFTER the server accepted and began the job.
    await request
      .post(`${BASE}/api/conversations/${id}/title?force=1`, { data: { model: "default" }, timeout: 2_500 })
      .then(async (r) => String(r.status()))
      .catch(() => "client-abandoned"); // the abandonment itself

    // The job persists server-side regardless of the abandoned connection.
    await expect
      .poll(
        async () => {
          const meta = (await (await request.get(`${BASE}/api/conversations/${id}`)).json()).meta;
          return meta.title !== first.slice(0, 40);
        },
        { timeout: 180_000, message: "abandoned title job never persisted" },
      )
      .toBe(true);

    const meta = (await (await request.get(`${BASE}/api/conversations/${id}`)).json()).meta;
    expect(meta.title.length).toBeGreaterThan(1);
    expect(meta.title.length).toBeLessThanOrEqual(60);
    expect(meta.titleSource).toBe("auto");
    expect(meta.titleGenCount).toBe(2);
    await request.delete(`${BASE}/api/conversations/${id}`);
  });

  test("after a chat cancellation the title route stays healthy (model-free probe)", async ({ request }) => {
    const id = "c_ttlhealth_" + Date.now();
    await seedConversation(request, id, { title: "User Chose This", titleSource: "manual" });
    const res = await request.post(`${BASE}/api/conversations/${id}/title?force=1`, { data: { model: "default" } });
    expect(res.ok()).toBeTruthy();
    const out = await res.json();
    expect(out.queued).toBe(false);
    expect(out.reason).toBe("manual"); // route answered through the Rust seam intact
    await request.delete(`${BASE}/api/conversations/${id}`);
  });
});
