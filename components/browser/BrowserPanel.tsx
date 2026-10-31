/**
 * Browser Panel (Browser Use, Phase 3) — the human's live window into
 * the Rust-owned Chromium session: a tab strip, omnibox + nav buttons,
 * and the screencast view the human can click/type/scroll inside.
 *
 * The panel is a CLIENT of the two published contracts only
 * (lib/browser-client/browserClient): RPC for mutations, the loopback
 * screencast socket for frames/input. It never talks to CDP, never
 * invents browser state, and — until the Phase-10 tool loop emits real
 * `browser:*` frames — opens only by explicit user action. Lazily
 * mounted with `next/dynamic` (ssr:false) from page.tsx so nothing here
 * rides the initial bundle (CLAUDE.md §5.1); styles ship with the
 * component chunk.
 *
 * Ownership note: mutations go through `runActingCommand`, which
 * claim-and-retries once on `browser_capability_blocked` — the §2.4
 * user-claim handoff. A tab the MODEL created is actable by the human
 * only through that explicit claim, mirroring the reference product's
 * shared-tab rule.
 */
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, MessageSquarePlus, Plus, RefreshCw, X } from "lucide-react";
import {
  BrowserSocket,
  keyMessage,
  mapPointerToViewport,
  mouseMessage,
  normalizeOmniboxUrl,
  readModifiers,
  runActingCommand,
  sendBrowserCommand,
  wheelMessage,
  captureAnnotationAnchor,
  dispatchRukeOpenAnnotation,
  type ApprovalDecision,
  type ApprovalRequestCard,
  type AuthHandoffAnswer,
  type AuthHandoffRequestCard,
  type BrowserTab,
  type UiServerMessage,
} from "../../lib/browser-client/browserClient";
import {
  addAnnotation,
  addApproval,
  addAuthHandoff,
  clearTakeover,
  closeBrowserPanel,
  mergeTab,
  removeAnnotation,
  removeApproval,
  removeAuthHandoff,
  selectTab,
  setConnected,
  setFrame,
  setPanelError,
  setTabs,
  setTakeover,
  useBrowserState,
} from "../../lib/browser-client/browserStore";
import {
  annotationComposerText,
  siteAnnotationComposerText,
} from "../../lib/browser-client/annotationPrompt";
import { AnnotationCards, ApprovalCards, AuthHandoffCards, takeoverSentence } from "./BrowserCards";
import "../../styles/browser-panel.css";

export default function BrowserPanel({ sessionId }: { sessionId: string }) {
  const {
    open,
    tabs,
    selected,
    frames,
    connected,
    agentActive,
    error,
    approvals,
    authHandoffs,
    takeovers,
    annotations,
  } = useBrowserState();

  // sessionId can change mid-mount (conversation switch); RPC session
  // must follow the CURRENT conversation, so the socket handlers read it
  // through a ref rather than closing over a stale prop.
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const socketRef = useRef<BrowserSocket | null>(null);
  const prevSubRef = useRef<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const natRef = useRef<{ w: number; h: number }>({ w: 800, h: 600 });
  const moveGateRef = useRef(0);
  const wheelAccRef = useRef<{ x: number; y: number; gate: number }>({ x: 0, y: 0, gate: 0 });

  const [omni, setOmni] = useState("");
  const selectedUrl = tabs.find((t) => t.tab_id === selected)?.url ?? "";
  // Omnibox mirrors the selected tab unless the human is mid-edit.
  const editingRef = useRef(false);
  useEffect(() => {
    if (!editingRef.current) setOmni(selectedUrl);
  }, [selectedUrl]);

  /* ── Phase 12: comment-on-selection + parked annotation cards ───────── */
  const [capturing, setCapturing] = useState(false);

  /** Ask the engine for a live anchor of the current selection
   *  (`browser_annotation_capture`, panel-only). `kind:"none"` is an
   *  honest "nothing selected" answer, surfaced as a panel hint. */
  const captureComment = useCallback(async () => {
    if (!selected) return;
    setCapturing(true);
    setPanelError(null);
    try {
      const res = await captureAnnotationAnchor(selected, sessionRef.current);
      if (!res.anchor || res.anchor.kind === "none") {
        setPanelError("Select something on the page first, then comment on it.");
        return;
      }
      addAnnotation({
        id: crypto.randomUUID(),
        tab_id: selected,
        anchor: res.anchor,
        source: "human",
      });
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : "annotation capture failed");
    } finally {
      setCapturing(false);
    }
  }, [selected]);

  /** Hand one parked card to the composer. The anchor details travel
   *  ONLY as marked untrusted evidence; the human's comment becomes the
   *  `Comment:` line and their typed request follows `## My request:`. */
  const addAnnotationToChat = useCallback(
    (id: string, comment: string) => {
      const card = annotations.find((c) => c.id === id);
      if (!card) return;
      const text = card.anchor
        ? annotationComposerText([{ anchor: card.anchor, comment }])
        : siteAnnotationComposerText(card.detail ?? { comment });
      dispatchRukeOpenAnnotation({ text, tab_id: card.tab_id });
      removeAnnotation(id);
    },
    [annotations],
  );

  /* ── socket lifecycle: connected while the panel is open ───────────── */
  useEffect(() => {
    if (!open) return;
    const socket = new BrowserSocket({
      onMessage: (msg: UiServerMessage) => {
        // Defensive field-by-field reads: the server's frame shapes are
        // pinned (Rust tests), but a panel must never crash on a
        // message shape it has not seen.
        if (Array.isArray((msg as { tabs?: unknown }).tabs)) {
          setTabs((msg as { tabs: BrowserTab[] }).tabs);
        } else if (msg.type === "frame") {
          const fm = msg as { tab_id?: unknown; data?: unknown };
          if (typeof fm.tab_id === "string" && typeof fm.data === "string") {
            setFrame(fm.tab_id, fm.data);
          }
        } else if (msg.type === "subscribed") {
          const sm = msg as { tab?: BrowserTab };
          if (sm.tab && typeof sm.tab.tab_id === "string") mergeTab(sm.tab);
        } else if (msg.type === "error") {
          const em = msg as { message?: string; error_code?: string };
          setPanelError(em.message ?? em.error_code ?? "browser panel error");
        } else if (msg.type === "approval_request") {
          // Phase 9 parked waiters: the engine's command is literally
          // paused until the matching card below is answered, so these
          // frames only park in the store — never auto-answered.
          const c = msg as Partial<ApprovalRequestCard>;
          if (typeof c.id === "string" && typeof c.tab_id === "string") {
            addApproval({
              type: "approval_request",
              id: c.id,
              action: typeof c.action === "string" ? c.action : "",
              facet: typeof c.facet === "string" ? c.facet : "",
              origin: typeof c.origin === "string" ? c.origin : "",
              url: typeof c.url === "string" ? c.url : "",
              tab_id: c.tab_id,
            });
          }
        } else if (msg.type === "auth_handoff_request") {
          const c = msg as Partial<AuthHandoffRequestCard>;
          if (typeof c.id === "string" && typeof c.tab_id === "string" && Array.isArray(c.fields)) {
            addAuthHandoff(msg as AuthHandoffRequestCard);
          }
        } else if (msg.type === "tab_takeover") {
          const c = msg as { tab_id?: unknown; reason?: unknown };
          if (typeof c.tab_id === "string") {
            setTakeover(c.tab_id, typeof c.reason === "string" ? c.reason : "user_requested");
          }
        } else if (msg.type === "approval_stale") {
          // Phase 11: the engine's turn that parked this card ended —
          // the wait already failed closed engine-side. Prune by id so
          // a too-late click can't surface as a panel error.
          const c = msg as { id?: unknown };
          if (typeof c.id === "string") {
            removeApproval(c.id);
            removeAuthHandoff(c.id);
          }
        } else if (msg.type === "open_annotation") {
          // Phase 12: a SITE asked for a comment — `document.oai.
          // annotation.request(...)` or a direct dispatch of the
          // verbatim `codex:open-annotation` page event, ferried out
          // through the CDP binding (Rust page_runtime.rs). Park a
          // card; it is evidence, never permission, and nothing is
          // sent until the human adds it to the chat.
          const c = msg as { tab_id?: unknown; detail?: unknown };
          if (typeof c.tab_id === "string") {
            addAnnotation({
              id: crypto.randomUUID(),
              tab_id: c.tab_id,
              anchor: null,
              detail: c.detail,
              source: "site",
            });
          }
        }
      },
      onConnectionChange: setConnected,
    });
    socketRef.current = socket;
    prevSubRef.current = null;
    void socket.connect();
    return () => {
      socket.close();
      socketRef.current = null;
      prevSubRef.current = null;
      setConnected(false);
    };
  }, [open]);

  /* ── one active view: subscribe the selected tab, drop the old ─────── */
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !socket.isOpen || selected === prevSubRef.current) return;
    if (prevSubRef.current) socket.unsubscribe(prevSubRef.current);
    if (selected) socket.subscribe(selected);
    prevSubRef.current = selected;
  }, [selected, connected]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        setPanelError(null);
        await fn();
      } catch (err) {
        setPanelError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const tabCmd = useCallback(
    (commandType: string, tabId: string) =>
      act(() => runActingCommand(commandType, { tab_id: tabId }, sessionRef.current)),
    [act],
  );

  /* ── Phase 9 card answers (each resolves one parked engine waiter) ── */
  const answerApprovalCard = useCallback((id: string, decision: ApprovalDecision) => {
    socketRef.current?.answerApproval(id, decision);
    removeApproval(id);
  }, []);

  const answerAuthCard = useCallback((id: string, answer: AuthHandoffAnswer) => {
    // Credential values leave the page exactly here: panel → engine →
    // CDP fill. The model never sees them (Rule 17 / auth-handoff law).
    socketRef.current?.answerAuthHandoff(id, answer);
    removeAuthHandoff(id);
  }, []);

  const returnTabToAgent = useCallback(() => {
    if (!selected) return;
    void act(async () => {
      // The claim flips taken_over back to false engine-side; every
      // viewer's row flag (tab_json) mirrors it, clearing the banner.
      await sendBrowserCommand(
        "browser_user_claim_tab",
        { tab_id: selected },
        sessionRef.current,
      );
      clearTakeover(selected);
    });
  }, [selected, act]);

  const submitOmnibox = useCallback(() => {
    const url = normalizeOmniboxUrl(omni);
    if (!url || !selected) return;
    void act(() =>
      runActingCommand("navigate_tab_url", { tab_id: selected, url }, sessionRef.current),
    );
  }, [omni, selected, act]);

  const openTab = useCallback(
    (url?: string) =>
      act(async () => {
        // `tab_new` answers the minimal row {browser_id, tab_id}; the
        // full listing arrives via the hub's tabs broadcast.
        const created = await sendBrowserCommand<{ tab_id: string }>(
          "tab_new",
          url ? { url } : {},
          sessionRef.current,
        );
        if (created?.tab_id) selectTab(created.tab_id);
      }),
    [act],
  );

  /* ── pointer input (mapped through the contain-fit letterbox) ──────── */
  // React's synthetic events do NOT carry offsetX/offsetY (only the
  // native event does) — read the nativeEvent for the geometry.
  const toViewport = useCallback((ev: { currentTarget: HTMLElement; nativeEvent: MouseEvent }) => {
    const box = ev.currentTarget.getBoundingClientRect();
    const nat = natRef.current;
    return mapPointerToViewport(box.width, box.height, nat.w, nat.h, ev.nativeEvent.offsetX, ev.nativeEvent.offsetY);
  }, []);

  const onPointerDown = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>) => {
      (ev.currentTarget as HTMLElement).focus();
      const socket = socketRef.current;
      if (!socket || !selected) return;
      const p = toViewport(ev);
      const button = ev.button === 1 ? "middle" : ev.button === 2 ? "right" : "left";
      socket.sendInput(
        selected,
        mouseMessage("press", p.x, p.y, {
          button,
          clickCount: Math.max(1, ev.detail),
          modifiers: readModifiers(ev),
        }),
      );
    },
    [selected, toViewport],
  );

  const onPointerUp = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>) => {
      const socket = socketRef.current;
      if (!socket || !selected) return;
      const p = toViewport(ev);
      const button = ev.button === 1 ? "middle" : ev.button === 2 ? "right" : "left";
      socket.sendInput(
        selected,
        mouseMessage("release", p.x, p.y, {
          button,
          clickCount: Math.max(1, ev.detail),
          modifiers: readModifiers(ev),
        }),
      );
    },
    [selected, toViewport],
  );

  const onPointerMove = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>) => {
      const socket = socketRef.current;
      if (!socket || !selected || !socket.isOpen) return;
      const now = Date.now();
      if (now - moveGateRef.current < 80) return;
      moveGateRef.current = now;
      const p = toViewport(ev);
      socket.sendInput(selected, mouseMessage("move", p.x, p.y, { modifiers: readModifiers(ev) }));
    },
    [selected, toViewport],
  );

  // Native non-passive listener: React's root wheel listener is passive,
  // so preventDefault (stop the CHAT page from scrolling behind the
  // panel) only works when we attach on the stage element ourselves.
  const stageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !open) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const socket = socketRef.current;
      if (!socket || !selected || !socket.isOpen) return;
      const acc = wheelAccRef.current;
      acc.x += ev.deltaX;
      acc.y += ev.deltaY;
      const now = Date.now();
      if (now - acc.gate < 60) return;
      acc.gate = now;
      const p = mapPointerToViewport(
        el.clientWidth, el.clientHeight, natRef.current.w, natRef.current.h,
        ev.offsetX, ev.offsetY,
      );
      socket.sendInput(selected, wheelMessage(p.x, p.y, acc.x, acc.y, readModifiers(ev)));
      acc.x = 0;
      acc.y = 0;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open, selected]);

  /* ── keyboard: forwarded verbatim; text rides keydown ──────────────── */
  const onKeyDown = useCallback(
    (ev: React.KeyboardEvent<HTMLDivElement>) => {
      const socket = socketRef.current;
      if (!socket || !selected) return;
      if (ev.key === "Tab") ev.preventDefault(); // keep focus inside the stage
      const printable = ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey;
      socket.sendInput(
        selected,
        keyMessage(
          "down",
          { key: ev.key, code: ev.code, text: printable ? ev.key : undefined, keyCode: ev.keyCode },
          readModifiers(ev),
        ),
      );
      if (printable || ev.key === "Enter") {
        // Char input lands via the keydown's text; no synthetic keyup
        // needed for the char itself, but Chromium still wants the up.
        socket.sendInput(selected, keyMessage("up", { key: ev.key, code: ev.code, keyCode: ev.keyCode }, readModifiers(ev)));
      }
    },
    [selected],
  );

  const onKeyUp = useCallback(
    (ev: React.KeyboardEvent<HTMLDivElement>) => {
      const socket = socketRef.current;
      if (!socket || !selected) return;
      const printable = ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey;
      if (printable || ev.key === "Enter") return; // already sent with keydown
      socket.sendInput(selected, keyMessage("up", { key: ev.key, code: ev.code, keyCode: ev.keyCode }, readModifiers(ev)));
    },
    [selected],
  );

  if (!open) return null;
  const frame = selected ? frames[selected] : undefined;

  return (
    <aside className="bp-panel" role="complementary" aria-label="Browser panel">
      <header className="bp-head">
        <span className="bp-title">Browser</span>
        <span className={`bp-conn${connected ? " on" : ""}`} role="status">
          {connected ? "● live" : "○ offline"}
        </span>
        {agentActive && <span className="bp-agent">RUKE is driving</span>}
        <button className="bp-icon" aria-label="Close browser panel" onClick={closeBrowserPanel}>
          <X size={15} />
        </button>
      </header>

      <div className="bp-strip" role="tablist" aria-label="Browser tabs">
        {tabs.map((t) => (
          <button
            key={t.tab_id}
            role="tab"
            aria-selected={t.tab_id === selected}
            className={`bp-tab${t.tab_id === selected ? " sel" : ""}`}
            title={t.url}
            onClick={() => selectTab(t.tab_id)}
          >
            <span className="bp-tab-title">{t.title || t.url || "untitled"}</span>
            <span
              className="bp-tab-close"
              role="button"
              aria-label={`Close tab ${t.title || t.url}`}
              onClick={(e) => {
                e.stopPropagation();
                void tabCmd("tab_close", t.tab_id);
              }}
            >
              <X size={12} />
            </span>
          </button>
        ))}
        <button className="bp-icon" aria-label="New tab" onClick={() => openTab()}>
          <Plus size={14} />
        </button>
      </div>

      <div className="bp-nav">
        <button className="bp-icon" aria-label="Back" disabled={!selected}
          onClick={() => void tabCmd("navigate_tab_back", selected!)}>
          <ArrowLeft size={14} />
        </button>
        <button className="bp-icon" aria-label="Forward" disabled={!selected}
          onClick={() => void tabCmd("navigate_tab_forward", selected!)}>
          <ArrowRight size={14} />
        </button>
        <button className="bp-icon" aria-label="Reload" disabled={!selected}
          onClick={() => void tabCmd("navigate_tab_reload", selected!)}>
          <RefreshCw size={14} />
        </button>
        <button className="bp-icon" aria-label="Comment on selection"
          disabled={!selected || capturing} onClick={() => void captureComment()}>
          <MessageSquarePlus size={14} />
        </button>
        <input
          className="bp-omni"
          value={omni}
          spellCheck={false}
          aria-label="Address bar"
          placeholder="Enter address"
          onChange={(e) => {
            editingRef.current = true;
            setOmni(e.target.value);
          }}
          onFocus={() => { editingRef.current = true; }}
          onBlur={() => { editingRef.current = false; }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submitOmnibox(); }
          }}
        />
      </div>

      {selected && takeovers[selected] && (
        <div className="bp-takeover" role="status">
          <span>{takeoverSentence(takeovers[selected])}</span>
          <button className="bp-btn bp-btn-primary" onClick={returnTabToAgent}>
            Return to agent
          </button>
        </div>
      )}

      <ApprovalCards cards={approvals} onAnswer={answerApprovalCard} />
      <AuthHandoffCards cards={authHandoffs} onAnswer={answerAuthCard} />
      <AnnotationCards
        cards={annotations}
        onAddToChat={addAnnotationToChat}
        onDismiss={removeAnnotation}
      />

      {error && (
        <div className="bp-error" role="alert">
          <span>{error}</span>
          <button className="bp-icon" aria-label="Dismiss error" onClick={() => setPanelError(null)}>
            <X size={13} />
          </button>
        </div>
      )}

      <div
        ref={stageRef}
        className="bp-stage"
        tabIndex={0}
        aria-label="Browser page (screencast)"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        {frame ? (
          <img
            ref={imgRef}
            className="bp-frame"
            src={frame}
            alt="Live browser page"
            draggable={false}
            onLoad={() => {
              const el = imgRef.current;
              if (el && el.naturalWidth > 0) natRef.current = { w: el.naturalWidth, h: el.naturalHeight };
            }}
          />
        ) : (
          <div className="bp-empty">
            {tabs.length === 0 ? (
              <>
                <p>No tabs open yet.</p>
                <input
                  className="bp-omni"
                  placeholder="Open a page…"
                  aria-label="Open first page"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const url = normalizeOmniboxUrl((e.target as HTMLInputElement).value);
                      if (url) { (e.target as HTMLInputElement).value = ""; openTab(url); }
                    }
                  }}
                />
              </>
            ) : (
              <p>{connected ? "Waiting for the first frame…" : "Browser engine offline — the panel reconnects automatically."}</p>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
