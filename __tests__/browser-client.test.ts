/**
 * Browser Panel client contract tests (Browser Use, Phase 3).
 *
 * Pins the THREE machine-critical surfaces of lib/browser-client:
 * 1. the RPC envelope Rust's `parse_envelope` expects (commandType /
 *    session_id / turn_id / payload with browser_id) and the
 *    `{"ok":true,"data"}` / HTTP-200 typed-error unwrapping;
 * 2. the claim-and-retry-once rule for `browser_capability_blocked`
 *    (and ONLY that code — everything else propagates untouched);
 * 3. the pure input/message builders + letterbox pointer math the
 *    screencast stage relies on (matches `input_dispatch` field names
 *    exactly: delta_x/delta_y, click_count, key_code, text-on-keydown).
 *
 * The loopback WS itself is admitted/guards-tested on the Rust side
 * (`tests/browser_ui_routes.rs`); nothing here touches a real network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_ID,
  BrowserCommandError,
  UI_TURN_ID,
  fetchWsTicket,
  keyMessage,
  mapPointerToViewport,
  mouseMessage,
  normalizeOmniboxUrl,
  readModifiers,
  runActingCommand,
  sendBrowserCommand,
  wheelMessage,
} from "../lib/browser-client/browserClient";

type RecordedCall = { url: string; init: RequestInit };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(replies: Array<() => Response>) {
  const calls: RecordedCall[] = [];
  let i = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    return reply();
  }) as unknown as typeof fetch;
  return calls;
}

const jsonResponse = (body: unknown, status = 200) =>
  () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("sendBrowserCommand envelope contract", () => {
  it("posts the Rust envelope verbatim and unwraps ok/data", async () => {
    const calls = stubFetch([jsonResponse({ ok: true, data: { browser_id: "default", tabs: [] } })]);
    const data = (await sendBrowserCommand("tabs", {}, "conv-1")) as { tabs: unknown[] };
    expect(data.tabs).toEqual([]);
    expect(calls[0].url).toBe("/api/browser");
    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.commandType).toBe("tabs");
    expect(body.session_id).toBe("conv-1");
    expect(body.turn_id).toBe(UI_TURN_ID);
    expect(body.payload.browser_id).toBe(BROWSER_ID);
  });

  it("raises HTTP-200 typed errors with Rust's error_code", async () => {
    stubFetch([
      jsonResponse({ ok: false, error_code: "browser_stale_tab", message: "tab 7 is gone" }),
    ]);
    const err = await sendBrowserCommand("get_tab", { tab_id: "7" }, "c").catch((e) => e) as BrowserCommandError;
    expect(err).toBeInstanceOf(BrowserCommandError);
    expect(err.errorCode).toBe("browser_stale_tab");
    expect(err.message).toBe("tab 7 is gone");
  });

  it("a non-JSON answer is a transport error, never a silent success", async () => {
    stubFetch([() => new Response("<html>gateway</html>", { status: 502 })]);
    const err = await sendBrowserCommand("tabs", {}, "c").catch((e) => e) as BrowserCommandError;
    expect(err).toBeInstanceOf(BrowserCommandError);
    expect(err.errorCode).toBe("browser_transport_error");
  });

  it("a rejected fetch becomes browser_transport_error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err = await sendBrowserCommand("tabs", {}, "c").catch((e) => e) as BrowserCommandError;
    expect(err.errorCode).toBe("browser_transport_error");
  });
});

describe("runActingCommand claim-and-retry", () => {
  it("claims once on browser_capability_blocked, then retries exactly once", async () => {
    const calls = stubFetch([
      jsonResponse({ ok: false, error_code: "browser_capability_blocked", message: "user tab" }),
      jsonResponse({ ok: true, data: { tab_id: "t1" } }), // claim
      jsonResponse({ ok: true, data: { navigated: true } }), // retry
    ]);
    const res = await runActingCommand("navigate_tab_url", { tab_id: "t1", url: "https://x.test" }, "c");
    expect(res).toEqual({ navigated: true });
    expect(calls).toHaveLength(3);
    const claim = JSON.parse(String(calls[1].init.body));
    expect(claim.commandType).toBe("browser_user_claim_tab");
    expect(claim.payload.tab_id).toBe("t1");
    const retry = JSON.parse(String(calls[2].init.body));
    expect(retry.commandType).toBe("navigate_tab_url");
  });

  it("any other error code propagates without a claim", async () => {
    const calls = stubFetch([
      jsonResponse({ ok: false, error_code: "browser_stale_tab", message: "gone" }),
    ]);
    await expect(runActingCommand("tab_close", { tab_id: "t9" }, "c")).rejects.toThrowError(
      BrowserCommandError,
    );
    expect(calls).toHaveLength(1);
  });

  it("a refusal with no tab_id cannot be claimed — no retry", async () => {
    const calls = stubFetch([
      jsonResponse({ ok: false, error_code: "browser_capability_blocked", message: "nope" }),
    ]);
    await expect(runActingCommand("tab_new", {}, "c")).rejects.toThrowError(BrowserCommandError);
    expect(calls).toHaveLength(1);
  });
});

describe("fetchWsTicket", () => {
  it("unwraps {ws_url, ticket, ttl_ms}", async () => {
    stubFetch([jsonResponse({ ok: true, data: { ws_url: "ws://127.0.0.1:3101/api/ruke/browser/ws", ticket: "a".repeat(32), ttl_ms: 60000 } })]);
    const t = await fetchWsTicket();
    expect(t.ws_url).toContain("/api/ruke/browser/ws");
    expect(t.ticket).toHaveLength(32);
  });

  it("an honest 503 posture surfaces as an error, never a fake ticket", async () => {
    stubFetch([
      jsonResponse(
        { ok: false, error_code: "browser_context_unavailable", message: "rust backend off" },
        503,
      ),
    ]);
    const err = await fetchWsTicket().catch((e) => e) as BrowserCommandError;
    expect(err).toBeInstanceOf(BrowserCommandError);
    expect(err.errorCode).toBe("browser_context_unavailable");
  });
});

describe("input builders match UiHub input_dispatch", () => {
  it("mouse: field names + defaults", () => {
    const press = mouseMessage("press", 10.5, 20.25, { button: "left", clickCount: 2, modifiers: { shift: true } });
    expect(press).toEqual({
      kind: "mouse", action: "press", x: 10.5, y: 20.25,
      button: "left", click_count: 2, modifiers: { shift: true },
    });
    const move = mouseMessage("move", 1, 2);
    expect(move.button).toBeUndefined();
    expect(move.click_count).toBeUndefined();
  });

  it("wheel: snake_case deltas", () => {
    expect(wheelMessage(5, 6, 0, 120, { ctrl: false })).toEqual({
      kind: "wheel", x: 5, y: 6, delta_x: 0, delta_y: 120, modifiers: { ctrl: false },
    });
  });

  it("key: text rides keydown only; key_code omitted at 0", () => {
    const down = keyMessage("down", { key: "a", code: "KeyA", text: "a", keyCode: 65 }, { alt: true });
    expect(down).toEqual({ kind: "key", action: "down", key: "a", code: "KeyA", text: "a", key_code: 65, modifiers: { alt: true } });
    const up = keyMessage("up", { key: "a", code: "KeyA", text: "a", keyCode: 0 });
    expect(up.text).toBeUndefined();
    expect(up.key_code).toBeUndefined();
  });

  it("modifiers read straight off a DOM event", () => {
    expect(readModifiers({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: true })).toEqual({
      alt: false, ctrl: true, meta: false, shift: true,
    });
  });
});

describe("mapPointerToViewport (contain-letterbox math)", () => {
  it("identity when the box matches the frame", () => {
    expect(mapPointerToViewport(800, 600, 800, 600, 400, 300)).toEqual({ x: 400, y: 300 });
  });

  it("scales uniformly when the box is a smaller multiple", () => {
    expect(mapPointerToViewport(400, 300, 800, 600, 100, 100)).toEqual({ x: 200, y: 200 });
  });

  it("undoes centered horizontal letterbox bars", () => {
    // box 1000x600, frame 800x600 → scale 1, bars of 100px on each side
    expect(mapPointerToViewport(1000, 600, 800, 600, 150, 40)).toEqual({ x: 50, y: 40 });
  });

  it("a bar click clamps to the frame EDGE, never out-of-frame coords", () => {
    const left = mapPointerToViewport(1000, 600, 800, 600, 50, 700);
    expect(left).toEqual({ x: 0, y: 600 });
  });

  it("vertical bars map with the same math", () => {
    // box 800x800, frame 800x600 → scale 1, bars of 100px top/bottom
    expect(mapPointerToViewport(800, 800, 800, 600, 400, 150)).toEqual({ x: 400, y: 50 });
  });

  it("degenerate geometry maps to the origin, not NaN", () => {
    expect(mapPointerToViewport(0, 0, 800, 600, 10, 10)).toEqual({ x: 0, y: 0 });
    expect(mapPointerToViewport(800, 600, 0, 0, 10, 10)).toEqual({ x: 0, y: 0 });
  });
});

describe("normalizeOmniboxUrl", () => {
  it("bare hosts get https; explicit schemes survive", () => {
    expect(normalizeOmniboxUrl("example.com")).toBe("https://example.com");
    expect(normalizeOmniboxUrl(" http://example.com ")).toBe("http://example.com");
    expect(normalizeOmniboxUrl("file:///C:/x.html")).toBe("file:///C:/x.html");
    expect(normalizeOmniboxUrl("   ")).toBe("");
  });
});
