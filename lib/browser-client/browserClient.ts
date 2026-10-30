/**
 * Browser Panel client (Browser Use, Phase 3).
 *
 * Two transports, both already live on the Rust side:
 * - **RPC** — `POST /api/browser` (Next proxy → Rust
 *   `/api/ruke/browser/command`). The wire contract is Rust's:
 *   `{"ok":true,"data":…}` for success and HTTP-200 typed errors
 *   `{"ok":false,"error_code","message"}`. We surface `error_code` as a
 *   typed `BrowserCommandError` so callers can react to
 *   `browser_capability_blocked` (claim-and-retry) without string
 *   matching prose.
 * - **Screencast socket** — dialled DIRECT against the loopback Rust
 *   server (Next cannot proxy a WS upgrade). One fresh one-shot ticket
 *   per (re)connect via `POST /api/browser/ticket`. Protocol (server:
 *   `crates/ruke-server/src/browser_routes.rs` + `ruke-browser`'s
 *   `UiHub`): client sends `{type:"subscribe"|"unsubscribe"|"input"|"ping", …}`;
 *   server pushes an initial snapshot, `{"type":"tabs","tabs":[…]}`
 *   listings, `{"type":"frame","tab_id","data","metadata"}` JPEGs,
 *   `{"type":"subscribed","tab":…}`, `{"type":"pong"}`, and typed error
 *   frames (`to_wire()` + `type:"error"`).
 *
 * Turn identity: every panel RPC carries the SAME stable turn id
 * (`UI_TURN_ID`) under the conversation's session id, so tabs the human
 * opened keep being operable across panel commands (Rust's ownership
 * floor compares `(session_id, turn_id)`; the claims map keys on the
 * turn id alone). The model loop never `end_turn`s a `ui` turn, so
 * turn-cleanup never closes the human's tabs.
 *
 * Nothing here talks to Chromium or CDP directly — the browser engine
 * owns the machine; this file only speaks the two published contracts.
 * Pure helpers (payload/message builders, pointer mapping) are exported
 * for the vitest contract tests in `__tests__/browser-client.test.ts`.
 */

export const BROWSER_ID = "default";
/** Stable panel turn id — see the header note on tab operability. */
export const UI_TURN_ID = "ui";

/** One registry row, verbatim from Rust's `tab_json`. */
export interface BrowserTab {
  tab_id: string;
  url: string;
  title: string;
  created_by_agent: boolean;
}

export interface WsTicket {
  ws_url: string;
  ticket: string;
  ttl_ms: number;
}

/** Wire error from the RPC (or a transport failure, code
 *  `browser_transport_error`). `errorCode` is Rust's `error_code`. */
export class BrowserCommandError extends Error {
  errorCode: string;
  constructor(errorCode: string, message: string) {
    super(message);
    this.name = "BrowserCommandError";
    this.errorCode = errorCode;
  }
}

interface WireEnvelope<T> {
  ok: boolean;
  data?: T;
  error_code?: string;
  message?: string;
}

/**
 * Send one browser command over the RPC proxy and unwrap the wire
 * envelope. Non-JSON answers (proxy 502, gateway HTML) become
 * `browser_transport_error` — never a silent success.
 */
export async function sendBrowserCommand<T = unknown>(
  commandType: string,
  payload: Record<string, unknown>,
  sessionId: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api/browser", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandType,
        session_id: sessionId,
        turn_id: UI_TURN_ID,
        payload: { browser_id: BROWSER_ID, ...payload },
      }),
    });
  } catch (err) {
    throw new BrowserCommandError(
      "browser_transport_error",
      `browser RPC could not reach the backend: ${String((err as Error)?.message ?? err)}`,
    );
  }
  let wire: WireEnvelope<T> | null = null;
  try {
    wire = (await res.json()) as WireEnvelope<T>;
  } catch {
    wire = null;
  }
  if (!wire || typeof wire.ok !== "boolean") {
    throw new BrowserCommandError(
      "browser_transport_error",
      `browser RPC answered non-contractually (HTTP ${res.status})`,
    );
  }
  if (!wire.ok) {
    throw new BrowserCommandError(
      wire.error_code ?? "browser_command_envelope_invalid",
      wire.message ?? "browser command failed",
    );
  }
  return wire.data as T;
}

/**
 * Claim-and-retry once (client half of the shared-tab story): a
 * mutation the Rust engine refuses with `browser_capability_blocked`
 * (tab belongs to another turn — e.g. one the MODEL created) is retried
 * after `browser_user_claim_tab`, which is exactly the §2.4 user handoff
 * claim. One retry only — a second refusal propagates.
 */
export async function runActingCommand<T = unknown>(
  commandType: string,
  payload: Record<string, unknown>,
  sessionId: string,
): Promise<T> {
  try {
    return await sendBrowserCommand<T>(commandType, payload, sessionId);
  } catch (err) {
    if (
      err instanceof BrowserCommandError &&
      err.errorCode === "browser_capability_blocked" &&
      typeof payload.tab_id === "string"
    ) {
      await sendBrowserCommand("browser_user_claim_tab", { tab_id: payload.tab_id }, sessionId);
      return sendBrowserCommand<T>(commandType, payload, sessionId);
    }
    throw err;
  }
}

/** Mint a fresh one-shot socket ticket (one per connect AND reconnect). */
export async function fetchWsTicket(): Promise<WsTicket> {
  let res: Response;
  try {
    res = await fetch("/api/browser/ticket", { method: "POST" });
  } catch (err) {
    throw new BrowserCommandError(
      "browser_transport_error",
      `ticket request failed: ${String((err as Error)?.message ?? err)}`,
    );
  }
  let wire: WireEnvelope<WsTicket> | null = null;
  try {
    wire = (await res.json()) as WireEnvelope<WsTicket>;
  } catch {
    wire = null;
  }
  if (!wire?.ok || !wire.data?.ws_url || !wire.data?.ticket) {
    throw new BrowserCommandError(
      wire?.error_code ?? "browser_transport_error",
      wire?.message ?? `ticket request failed (HTTP ${res.status})`,
    );
  }
  return wire.data;
}

/**
 * Omnibox URL policy: a bare host gets `https://`; anything already
 * carrying a scheme passes through untouched (we never silently rewrite
 * http/WS URLs a user typed deliberately).
 */
export function normalizeOmniboxUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url;
  return `https://${url}`;
}

/* ── input event builders (payloads match UiHub `input_dispatch`) ───────── */

export interface InputModifiers {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export interface InputPointerEvent {
  kind: "mouse";
  action: "move" | "press" | "release";
  x: number;
  y: number;
  button?: "left" | "middle" | "right" | "none";
  click_count?: number;
  modifiers?: InputModifiers;
}

export interface InputWheelEvent {
  kind: "wheel";
  x: number;
  y: number;
  delta_x: number;
  delta_y: number;
  modifiers?: InputModifiers;
}

export interface InputKeyEvent {
  kind: "key";
  action: "down" | "up";
  key: string;
  code?: string;
  /** char text — rides keydown so Chromium synthesizes the char event */
  text?: string;
  key_code?: number;
  modifiers?: InputModifiers;
}

export interface InputTextEvent {
  kind: "insert_text";
  text: string;
}

export type BrowserInputEvent =
  | InputPointerEvent
  | InputWheelEvent
  | InputKeyEvent
  | InputTextEvent;

export function readModifiers(ev: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): InputModifiers {
  return { alt: ev.altKey, ctrl: ev.ctrlKey, meta: ev.metaKey, shift: ev.shiftKey };
}

export function mouseMessage(
  action: InputPointerEvent["action"],
  x: number,
  y: number,
  opts: { button?: InputPointerEvent["button"]; clickCount?: number; modifiers?: InputModifiers } = {},
): InputPointerEvent {
  const msg: InputPointerEvent = { kind: "mouse", action, x, y };
  if (opts.button !== undefined) msg.button = opts.button;
  if (opts.clickCount !== undefined) msg.click_count = opts.clickCount;
  if (opts.modifiers) msg.modifiers = opts.modifiers;
  return msg;
}

export function wheelMessage(
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
  modifiers?: InputModifiers,
): InputWheelEvent {
  const msg: InputWheelEvent = { kind: "wheel", x, y, delta_x: deltaX, delta_y: deltaY };
  if (modifiers) msg.modifiers = modifiers;
  return msg;
}

export function keyMessage(
  action: InputKeyEvent["action"],
  ev: {
    key: string;
    code?: string;
    /** single printable char (KeyboardEvent.key when length === 1) */
    text?: string;
    keyCode?: number;
  },
  modifiers?: InputModifiers,
): InputKeyEvent {
  const msg: InputKeyEvent = { kind: "key", action, key: ev.key };
  if (ev.code) msg.code = ev.code;
  if (action === "down" && ev.text) msg.text = ev.text;
  if (typeof ev.keyCode === "number" && ev.keyCode > 0) msg.key_code = ev.keyCode;
  if (modifiers) msg.modifiers = modifiers;
  return msg;
}

export function insertTextMessage(text: string): InputTextEvent {
  return { kind: "insert_text", text };
}

/* ── pointer → page-viewport mapping (letterbox-aware, pure) ───────────── */

export interface ViewportPoint {
  x: number;
  y: number;
}

/**
 * The screencast frame is the browser VIEWPORT at its native pixel size
 * (800×600 for the default headless window); CDP input coordinates are
 * viewport CSS pixels. The canvas shows that frame CONTAIN-fit
 * (letterboxed) inside its CSS box, so a pointer at (offsetX, offsetY)
 * inside the canvas maps to: undo the centered letterbox bars, divide by
 * the uniform scale, and clamp into the frame — clicking a letterbox bar
 * lands on the page EDGE rather than inventing out-of-frame coordinates.
 * Returns native frame coordinates (the input space `input_dispatch`
 * validates as non-negative).
 */
export function mapPointerToViewport(
  cssW: number,
  cssH: number,
  natW: number,
  natH: number,
  offsetX: number,
  offsetY: number,
): ViewportPoint {
  if (natW <= 0 || natH <= 0 || cssW <= 0 || cssH <= 0) return { x: 0, y: 0 };
  const scale = Math.min(cssW / natW, cssH / natH);
  const barX = (cssW - natW * scale) / 2;
  const barY = (cssH - natH * scale) / 2;
  const x = (offsetX - barX) / scale;
  const y = (offsetY - barY) / scale;
  return {
    x: Math.min(natW, Math.max(0, x)),
    y: Math.min(natH, Math.max(0, y)),
  };
}

/* ── screencast socket ──────────────────────────────────────────────────── */

export type UiServerMessage =
  | { type?: undefined; browser_id?: string; tabs: BrowserTab[] } // initial snapshot
  | { type: "tabs"; tabs: BrowserTab[] }
  | { type: "frame"; tab_id: string; data: string; metadata?: unknown }
  | { type: "subscribed"; tab: BrowserTab }
  | { type: "pong" }
  | { type: "error"; ok?: false; error_code?: string; message?: string }
  | { type: string; [k: string]: unknown };

export interface SocketHandlers {
  onMessage(msg: UiServerMessage): void;
  onConnectionChange(connected: boolean): void;
}

/**
 * One live socket owned by the panel. Reconnects with a fixed 2 s
 * backoff ONLY while it was explicitly kept open (`close()` stops the
 * loop; the next `connect()` restarts it) — each attempt mints a FRESH
 * one-shot ticket, and every tab subscribed before the drop is
 * re-subscribed right after the socket re-opens.
 */
export class BrowserSocket {
  private ws: WebSocket | null = null;
  private wantOpen = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly subs = new Set<string>();

  constructor(private readonly handlers: SocketHandlers) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.wantOpen) return;
    this.wantOpen = true;
    await this.open();
  }

  close(): void {
    this.wantOpen = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.subs.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already gone */
      }
      this.ws = null;
    }
  }

  subscribe(tabId: string): void {
    this.subs.add(tabId);
    this.send({ type: "subscribe", tab_id: tabId });
  }

  unsubscribe(tabId: string): void {
    this.subs.delete(tabId);
    this.send({ type: "unsubscribe", tab_id: tabId });
  }

  sendInput(tabId: string, event: BrowserInputEvent): void {
    this.send({ type: "input", tab_id: tabId, event });
  }

  private send(obj: Record<string, unknown>): void {
    if (this.isOpen && this.ws) this.ws.send(JSON.stringify(obj));
  }

  private async open(): Promise<void> {
    let ticket: WsTicket;
    try {
      ticket = await fetchWsTicket();
    } catch {
      // Ticket hop failed (backend down, 503 posture) — honest
      // disconnected state, retry on the same backoff while wanted.
      this.scheduleReconnect();
      return;
    }
    const ws = new WebSocket(`${ticket.ws_url}?ticket=${encodeURIComponent(ticket.ticket)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.handlers.onConnectionChange(true);
      // Re-establish the human's views after a reconnect.
      for (const tabId of this.subs) this.send({ type: "subscribe", tab_id: tabId });
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let msg: UiServerMessage;
      try {
        msg = JSON.parse(ev.data) as UiServerMessage;
      } catch {
        return; // never act on unparseable frames
      }
      this.handlers.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.handlers.onConnectionChange(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose always follows an error; nothing extra to do but keep
      // the reconnect bookkeeping honest.
    };
  }

  private scheduleReconnect(): void {
    if (!this.wantOpen || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.open();
    }, 2000);
  }
}
