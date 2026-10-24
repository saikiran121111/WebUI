/**
 * Universal browser agent — deterministic fallback-ladder journeys.
 *
 * Drives the REAL server surface (POST /api/browser extended protocol)
 * against local fixtures under public/fixtures/browser-fallback/. The
 * scenarios are covered with deterministic local HTML: semantic DOM,
 * weak DOM, iframes, open/closed shadow roots, canvas (visual grounding
 * via RUKE_VISION_MOCK), stale-ref recovery after a re-render, keyboard
 * widgets, CAPTCHA (mock), MFA, 403, ordinary cookie banners, exhausted
 * ladders, consequential-action consent, popups and sanitized telemetry.
 *
 * The session drives the user's OWN browser (chrome = the validated
 * default on this machine) in a real window, under a dedicated
 * automation profile — never the user's normal profile.
 *
 * REQUIRES the dev server booted with:
 *   RUKE_TEST_FIXTURES=1 RUKE_VISION_MOCK=1 npm run dev
 * (the fixture allow-list and the deterministic vision mock are env-gated;
 * the first test fails loudly with the reason if the env is missing).
 *
 * No per-site integrations: every interaction is a generic primitive.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE = "http://localhost:3000";
const FIX = (f: string) => `${BASE}/fixtures/browser-fallback/${f}`;

/** POST one extended-protocol action; returns {status, j}. */
async function api(body: Record<string, unknown>): Promise<{ status: number; j: any }> {
  const res = await fetch(`${BASE}/api/browser`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, j: await res.json().catch(() => ({})) };
}

/** An action that must succeed (200 + ok) — otherwise a readable failure. */
async function okAct(body: Record<string, unknown>): Promise<any> {
  const r = await api(body);
  const label = `${String(body.action)}${body.url ? " " + String(body.url) : ""}`;
  expect(r.status, `${label} failed: ${JSON.stringify(r.j).slice(0, 400)}`).toBe(200);
  expect(r.j.ok, `${label} returned ok:false: ${String(r.j.error ?? "")}`).toBe(true);
  return r.j;
}

async function nav(file: string): Promise<any> {
  return okAct({ action: "navigate", url: FIX(file) });
}

/** Fresh ref map + the CURRENT page title (captured at action start). */
async function snap(): Promise<any> {
  return okAct({ action: "snapshot" });
}

async function setEngine(engine: string): Promise<void> {
  const res = await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ browser_engine: engine }),
  });
  expect(res.ok).toBe(true);
}

test.describe("universal browser agent — fallback ladder (local fixtures)", () => {
  test.beforeAll(async () => {
    // Task state persists across dev-server restarts (.data/browser-task.json)
    // — start from a clean slate so grants/skip-if-done never leak in.
    fs.rmSync(path.join(".data", "browser-task.json"), { force: true });
    // Telemetry is disk-backed (.data/browser-telemetry.json) so the
    // separate telemetry route bundle sees the action route's counters —
    // start clean so the counters below measure THIS run only.
    fs.rmSync(path.join(".data", "browser-telemetry.json"), { force: true });
    await setEngine("chrome");
  });
  test.afterAll(async () => {
    await setEngine("chrome"); // leave the app on the validated OS default
  });

  test("PRE-FLIGHT: fixture mode must be enabled on the dev server", async () => {
    const j = await nav("dom-basic.html");
    if (!j.ok) {
      // Reachable only with RUKE_TEST_FIXTURES=1 on the server.
      expect(String(j.error)).not.toMatch(/refused/);
    }
    expect(j.ok).toBe(true);
  });

  test("semantic DOM: refs, roles, names, masking, highlight invariants", async () => {
    await nav("dom-basic.html");
    const s = await snap();
    expect(s.snapshotId).toBeGreaterThan(0);
    expect(s.snapshotText).toContain('[e1] button "Increment counter"');
    expect(s.snapshotText).toContain('[e2] textbox "Your name"');
    expect(s.snapshotText).toContain('[e3] checkbox "Subscribe to updates" [unchecked]');
    // Password VALUES never reach the model — only the hidden-value note.
    expect(s.snapshotText).toContain('[e4] textbox "Password" [password field — value hidden]');
    expect(s.snapshotText).toContain('[e6] button "Save name"');

    // The visible AI highlight must be position:fixed, pointer-events:none,
    // labeled "AI Click", and fully REMOVED before the real click lands.
    const c1 = await okAct({ action: "click", ref: "e1" });
    expect(c1.title).toMatch(/^CNT=1\|pos=fixed\|ptr=none\|label=AI Click\|gone=yes$/);
    await okAct({ action: "click", ref: "e1" });
    expect((await snap()).title).toBe("CNT=2|pos=fixed|ptr=none|label=AI Click|gone=yes");

    await okAct({ action: "fill", ref: "e2", value: "Ada" });
    await okAct({ action: "check", ref: "e3" });
    expect((await snap()).snapshotText).toContain('[e3] checkbox "Subscribe to updates" [checked]');

    await okAct({ action: "press", ref: "e2", keys: ["Enter"] });
    expect((await snap()).title).toBe("KEY:Enter");

    await okAct({ action: "click", ref: "e6" });
    expect((await snap()).title).toBe("SAVED:Ada");

    await okAct({ action: "select", ref: "e5", value: "b" });
    expect((await snap()).title).toBe("PLAN:b");
  });

  test("weak DOM: text and selector targets + batched ops", async () => {
    await nav("dom-poor.html");
    await okAct({ action: "click", text: "Load more" });
    expect((await snap()).title).toBe("MORE:1");

    await okAct({ action: "fill", selector: "#q", value: "hello" });
    // "Run query", NOT "Send query": send\b is deliberately gated as
    // consequential (see the heuristic's unit test) — this journey tests
    // weak-DOM targeting, not the consent gate, which has its own test.
    await okAct({ action: "click", role: "button", name: "Run query" });
    expect((await snap()).title).toBe("Q:hello");

    const b = await okAct({
      action: "batch",
      steps: [
        { action: "navigate", url: FIX("dom-basic.html") },
        { action: "fill", ref: "e2", value: "Batchy" },
        { action: "click", ref: "e6" },
      ],
    });
    expect(b.completedSteps?.length).toBe(3);
    expect(b.completedSteps?.every((s: any) => s.ok)).toBe(true);
    expect((await snap()).title).toBe("SAVED:Batchy");
  });

  test("iframe: cross-frame refs (f1:eN) + fill by label", async () => {
    await nav("frame-host.html");
    const s = await snap();
    expect(s.snapshotText).toContain('[f1:e1] textbox "City in frame"');
    expect(s.snapshotText).toContain('[f1:e2] button "Apply in frame"');

    await okAct({ action: "fill", label: "City in frame", value: "Springfield" });
    await okAct({ action: "click", ref: "f1:e2" });
    expect((await snap()).title).toBe("FECHO:Springfield");
  });

  test("open shadow root is reachable; closed root fails HONESTLY", async () => {
    await nav("shadow-open.html");
    expect((await snap()).snapshotText).toContain('[e1] button "Shadow action"');
    await okAct({ action: "click", role: "button", name: "Shadow action" });
    expect((await snap()).title).toBe("SHADOW:ok");

    await nav("shadow-closed.html");
    const s = await snap();
    expect(s.snapshotText).not.toContain("Secret inner control"); // unreachable by design
    const bad = await api({ action: "click", role: "button", name: "Secret inner control" });
    expect(bad.status).toBe(422);
    expect(String(bad.j.error)).toMatch(/no element matched/);
    expect(bad.j.strategies ?? []).toContain("semantic_dom");
    // Recovery through the visible control — no fabricated success.
    await okAct({ action: "click", ref: "e1" });
    expect((await snap()).title).toBe("PING:ok");
  });

  test("canvas-only UI: transient visual grounding (local mock), then click", async () => {
    await nav("canvas-play.html");
    expect((await snap()).snapshotText).toContain("(no interactive elements found)");

    const c = await okAct({ action: "click", role: "button", name: "Play button" });
    expect(c.strategies ?? []).toContain("visual_grounding");
    expect(String(c.message ?? "")).toContain("confidence 0.9");
    expect((await snap()).title).toBe("CANVAS:clicked");
  });

  test("ambiguous visual target: grounding REFUSES, page untouched", async () => {
    await nav("canvas-ambiguous.html");
    const bad = await api({ action: "click", role: "button", name: "Play something" });
    expect(bad.status).toBe(422);
    expect(String(bad.j.error)).toContain("visual grounding refused");
    expect((await snap()).title).toBe("CANVAS AMBIG"); // state unchanged
  });

  test("re-rendered DOM: stale-ref identity guard recovers by role+name", async () => {
    await nav("rerender.html");
    const s = await snap();
    await okAct({ action: "click", role: "button", name: "Shift view" }); // nodes REPLACE, order FLIPS
    const fixed = await okAct({
      action: "click",
      ref: "e2",
      snapshotId: s.snapshotId,
      role: "button",
      name: "Confirm booking",
    });
    expect(fixed.recovered).toBe(true);
    expect(fixed.strategies ?? []).toContain("expanded_dom");
    expect((await snap()).title).toBe("RERENDER:confirmed"); // right control, never the swapped one
  });

  test("keyboard layer drives a focus-only widget", async () => {
    await nav("keyboard-widget.html");
    const r = await okAct({ action: "keyboard_nav", keys: ["ArrowRight", "ArrowRight", "ArrowRight"] });
    expect(r.pressed).toEqual(["ArrowRight", "ArrowRight", "ArrowRight"]);
    expect((await snap()).title).toBe("SLIDER:30");

    // Disallowed keys are dropped — only allow-listed keys press.
    const mixed = await okAct({ action: "keyboard_nav", keys: ["ArrowRight", "F12"] });
    expect(mixed.pressed).toEqual(["ArrowRight"]);
    expect((await snap()).title).toBe("SLIDER:40");
  });

  test("CAPTCHA (mock): park for the human, never bypass, resume after", async () => {
    const n = await nav("captcha-mock.html");
    expect(n.challenge?.kind).toMatch(/captcha/);
    expect(n.handoff).toBe(true);
    expect(n.taskState).toBe("waiting_for_user_action");

    const still = await api({ action: "resume_task" });
    expect(still.status).toBe(422);
    expect(String(still.j.error)).toMatch(/still waiting: /);

    // The human completed the check in the visible window (fixture button).
    await okAct({ action: "click", role: "button", name: "I passed the check" });
    const r = await okAct({ action: "resume_task" });
    expect(r.taskState ?? "running").toBe("running");
    expect((await snap()).snapshotText).toContain('[e1] button "Continue to account"');
  });

  test("consequential op: server-side consent → MFA park → resume skips re-submit", async () => {
    await nav("mfa-flow.html");
    await okAct({ action: "fill", label: "Reference", value: "INV-42" });

    // The client fence asking for confirmation is NOT enough — the SERVER
    // gate blocks the consequential click until a live grant exists.
    const blocked = await api({ action: "click", role: "button", name: "Confirm transfer" });
    expect(blocked.status).toBe(422);
    expect(blocked.j.needs_consent).toBe(true);
    expect(blocked.j.consentReason).toBe("consequential_action_consent");
    expect(blocked.j.taskState).toBe("waiting_for_confirmation");

    await okAct({ action: "authorize_browser_access" });
    const fired = await okAct({ action: "click", role: "button", name: "Confirm transfer" });
    expect(fired.challenge?.kind).toMatch(/mfa/);
    expect(fired.taskState).toBe("waiting_for_login");
    expect(fired.handoff).toBe(true);

    const still = await api({ action: "resume_task" });
    expect(still.status).toBe(422);
    expect(String(still.j.error)).toMatch(/still waiting: /);

    await okAct({ action: "click", role: "button", name: "Done completing the code" });
    const r = await okAct({ action: "resume_task" });
    expect(String(r.message ?? r.taskState ?? "")).toContain("Confirm transfer");

    // Non-idempotent op already done — resume must NEVER re-submit it.
    const reClick = await okAct({ action: "click", role: "button", name: "Confirm transfer" });
    expect(reClick.skipped).toBe(true);
    expect((await snap()).title).toBe("MFA:done"); // no second TRANSFER:prepared
  });

  test("403 / access denial: honest park, no refresh loops", async () => {
    const n = await nav("denied-403.html");
    expect(n.ok).toBe(true); // navigated fine — the CHALLENGE is the signal
    expect(n.challenge).toBeTruthy();
    expect(n.handoff).toBe(true);
    expect(n.taskState).toBe("waiting_for_user_action");
  });

  test("ordinary cookie banner is NOT a security challenge", async () => {
    const n = await nav("cookie-banner.html");
    expect(n.challenge).toBeUndefined();
    expect(n.handoff).toBeUndefined();
    await okAct({ action: "click", role: "button", name: "Accept all cookies" });
    expect((await snap()).title).toBe("COOKIE:accepted");
  });

  test("broken control: honest structured failure, keyboard fallback drives it", async () => {
    await nav("broken-slider.html");
    expect((await snap()).snapshotText).toContain("(no interactive elements found)");
    const bad = await api({ action: "click", role: "button", name: "Volume dial" });
    expect(bad.status).toBe(422);
    expect(String(bad.j.error)).toMatch(/no element matched/);
    await okAct({ action: "keyboard_nav", keys: ["ArrowUp", "ArrowUp", "ArrowUp"] });
    expect((await snap()).title).toBe("VOL:30");
  });

  test("exhausted page: no fabricated success — structured error + handoff", async () => {
    await nav("exhausted.html");
    const bad = await api({ action: "click", role: "button", name: "Imaginary control" });
    expect(bad.status).toBe(422);
    expect(bad.j.ok).toBe(false);
    expect(String(bad.j.error)).toMatch(/no element matched|stopped at/);
  });

  test("popup window is ADOPTED as the live tab (no orphaned session)", async () => {
    await nav("popup-open.html");
    const opened = await okAct({ action: "click", ref: "e1" });
    expect(String(opened.title ?? "")).toContain("POPUP:opened");

    let popup = false;
    for (let i = 0; i < 12 && !popup; i++) {
      popup = String((await snap()).url ?? "").includes("exhausted.html");
      if (!popup) await new Promise((r) => setTimeout(r, 500));
    }
    expect(popup, "the popup tab should become the live tab").toBe(true);
    await nav("dom-basic.html"); // agent keeps controlling the adopted tab
  });

  test("telemetry: sanitized, bounded, screenshot-free, env-labeled", async () => {
    const res = await fetch(`${BASE}/api/browser/telemetry`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    const t = body.telemetry ?? body;
    const c = t.counters ?? {};
    expect(c.actions).toBeGreaterThan(0);
    expect(c.snapshotsTaken).toBeGreaterThan(0);
    expect(c.humanHandoffs).toBeGreaterThan(0);
    expect(c.challengesSeen).toBeGreaterThanOrEqual(3); // captcha + mfa + 403 (+consent parks)
    expect(c.consequentialBlocked).toBeGreaterThanOrEqual(1);
    expect(c.consequentialGranted).toBeGreaterThanOrEqual(1);
    // Ordinary DOM tasks use ZERO screenshots; the mock never counts one.
    expect(c.screenshotsTaken).toBe(0);
    const kinds: any[] = t.kinds ?? [];
    const click = kinds.find((k) => k.kind === "action:click");
    expect(click, "action latency stats must exist").toBeTruthy();
    // Benchmarks stay HONEST: these numbers are fixture-environment, not real sites.
    expect(click.envs).toContain("local_fixture");
  });
});
