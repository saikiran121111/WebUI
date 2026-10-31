// Phase-18 no-model E2E helpers: drive the REAL product stack over its real
// HTTP surface — Playwright request → Next proxy `POST /api/browser` → Rust
// browser RPC → engine → Playwright-bundled Chromium against the fixture
// server (`tests/fixtures/browser/server.mjs`, port 3210). No model, no
// inference: every turn uses the human turn id "ui" (gate- and budget-exempt,
// exactly the identity the Browser Panel uses). Assertions read REAL page
// state — never command-echoes, never model text.
//
// The marker constants mirror `fixture_journeys.rs` and the fixture server
// EXACTLY; if a marker changes, change server + Rust test + these specs in
// the same edit.

import { expect, type APIRequestContext } from "@playwright/test";

export const FIXTURE_BASE = "http://127.0.0.1:3210";
const BROWSER_ID = "default";

// ── fixture marker contract (mirror of server.mjs + fixture_journeys.rs) ──
export const EASY_ARRIVED = "EASY-ARRIVED-7C21";
export const POPUP_CHILD_MARKER = "POPUP-CHILD-MARKER-4417";
export const FRAME_MARKER = "VERCODE-7731";
export const LATE_MARKER = "LATE-CONTENT-5150";
export const SHADOW_MARKER = "SHADOW-SECRET-8123";
export const ALERT_MESSAGE = "RUKE-ALERT-2026";
export const DOWNLOAD_CONTENT = "RUKE-DOWNLOAD-9F3A-0123456789ABCDEF";
export const DOWNLOAD_FILENAME = "ruke-fixture-download.bin";
export const DEVLOG_INFO = "DEVLOG-INFO-6031";
export const DEVLOG_ERROR = "DEVLOG-ERROR-6032";
export const UPLOAD_MARKER = "UPLOAD-MARKER-3C8E";
export const UPLOAD_FILENAME = "upload-src.txt";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type TabRow = { tab_id?: string; url?: string; [k: string]: unknown };

export class BrowserE2E {
  constructor(private readonly req: APIRequestContext, readonly session: string) {}

  /// One RPC round-trip: envelope → `{"ok":true,"data":…}` or a typed
  /// HTTP-200 error (`{"ok":false,"error_code":…,"message":…}` — the wire
  /// contract keys off error_code, never HTTP status).
  async command(
    commandType: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const res = await this.req.post("/api/browser", {
      data: {
        commandType,
        session_id: this.session,
        turn_id: "ui",
        payload: { browser_id: BROWSER_ID, ...payload },
      },
    });
    expect(
      res.ok(),
      `POST /api/browser ${commandType} failed at transport level: HTTP ${res.status()}`,
    ).toBe(true);
    const body = await res.json();
    expect(
      body.ok,
      `browser command ${commandType} refused: ${body.error_code} — ${body.message}`,
    ).toBe(true);
    return body.data as Record<string, unknown>;
  }

  async newTab(): Promise<string> {
    const r = await this.command("tab_new");
    const id = r.tab_id as string | undefined;
    expect(id, `tab_new answered no tab_id: ${JSON.stringify(r)}`).toBeTruthy();
    return id!;
  }

  async navigate(tab: string, path: string): Promise<Record<string, unknown>> {
    return this.command("navigate_tab_url", { tab_id: tab, url: `${FIXTURE_BASE}${path}` });
  }

  async click(tab: string, selector: string): Promise<Record<string, unknown>> {
    return this.command("playwright_locator_click", { tab_id: tab, selector });
  }

  async innerText(tab: string, selector: string): Promise<string> {
    const r = await this.command("playwright_locator_inner_text", {
      tab_id: tab,
      selector,
    });
    return (r.text as string | undefined) ?? "";
  }

  /// Live-page read through the tab's real CDP session (Runtime.evaluate,
  /// returnByValue). The tab_cdp_call answer nests the raw CDP reply under
  /// `result`: the evaluated value sits at result.result.value.
  async evaluate(tab: string, expression: string): Promise<unknown> {
    const r = await this.command("tab_cdp_call", {
      tab_id: tab,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true },
    });
    const nested = r.result as Record<string, unknown> | undefined;
    const inner = nested?.result as Record<string, unknown> | undefined;
    return inner?.value;
  }

  /// `playwright_evaluate` (gated mutation path) — answer carries `result`.
  async pwEvaluate(tab: string, script: string): Promise<unknown> {
    const r = await this.command("playwright_evaluate", { tab_id: tab, script });
    return r.result;
  }

  async listTabs(): Promise<TabRow[]> {
    const r = await this.command("tabs");
    return (r.tabs as TabRow[] | undefined) ?? [];
  }

  async getTab(tab: string): Promise<Record<string, unknown>> {
    return this.command("get_tab", { tab_id: tab });
  }

  /// Poll the tab list until a tab NOT in `known` carries `urlSuffix`.
  async waitForNewTab(known: string[], urlSuffix: string): Promise<string> {
    for (let i = 0; i < 60; i++) {
      for (const t of await this.listTabs()) {
        if (
          typeof t.tab_id === "string" &&
          !known.includes(t.tab_id) &&
          (t.url ?? "").endsWith(urlSuffix)
        ) {
          return t.tab_id;
        }
      }
      await sleep(200);
    }
    throw new Error(`no new tab with url suffix "${urlSuffix}" appeared`);
  }

  /// afterAll sweep: close every tab whose URL is on the fixture server.
  /// The fixture is E2E-only infrastructure, so anything sitting on it was
  /// opened by these specs (adopted popups included — they never get an
  /// end_turn on the live "ui" identity).
  async closeFixtureTabs(): Promise<void> {
    for (const t of await this.listTabs()) {
      if (typeof t.tab_id === "string" && (t.url ?? "").startsWith(FIXTURE_BASE)) {
        await this.command("tab_close", { tab_id: t.tab_id }).catch(() => {
          // Already closed by a sibling test in this file — sweep is best-effort.
        });
      }
    }
  }
}

/// Fail loudly (with the fix hint) unless the deterministic fixture server
/// is answering. The exclusive launcher starts it; standalone runs get an
/// honest failure, not a hang.
export async function assertFixtureServerUp(req: APIRequestContext): Promise<void> {
  let up = false;
  for (let i = 0; i < 10 && !up; i++) {
    try {
      const res = await req.get(`${FIXTURE_BASE}/easy`, { timeout: 2000 });
      up = res.ok();
    } catch {
      await sleep(500);
    }
  }
  expect(
    up,
    "fixture server is not answering on 127.0.0.1:3210 — run these specs via " +
      "scripts/run-browser-e2e-exclusive.ps1 (it starts the fixture + dev server)",
  ).toBe(true);
}
