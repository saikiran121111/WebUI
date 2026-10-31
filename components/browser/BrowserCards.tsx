/**
 * Browser Panel decision cards (Browser Use, Phase 9) — the human's
 * half of the authority model. The Rust engine PARKS a gated command
 * (or a browser-auth handoff) until one of these cards is answered, so
 * the card IS the permission UI: no card, no consent (the engine's
 * no-panel refusal and 120 s/300 s timeouts are the backstops).
 *
 * Security laws honored here:
 * - Credential values are typed into these inputs and travel ONLY
 *   panel → engine → CDP fill (never through the model, never echoed
 *   back from model data, never logged). The card renders labels and
 *   selectors the ENGINE chose; page text/DOM is never permission.
 * - `account_identifier` is engine-provided (a sign-in the human
 *   already authorized), not model-authored text rendered as trusted.
 * - QR sign-in: the QR lives on the PAGE (the screencast shows it);
 *   the card only tells the human scanning is the ask.
 *
 * Split out of BrowserPanel.tsx per CLAUDE.md §5.2 (component size).
 */
"use client";
import { useState } from "react";
import { KeyRound, MessageSquareText, ShieldAlert, X } from "lucide-react";
import { authVisibleFields } from "../../lib/browser-client/browserClient";
import type {
  ApprovalDecision,
  ApprovalRequestCard,
  AuthHandoffAnswer,
  AuthHandoffRequestCard,
} from "../../lib/browser-client/browserClient";
import type { AnnotationCard } from "../../lib/browser-client/browserStore";

const FACET_LABELS: Record<string, string> = {
  access: "visit this site",
  uploads: "upload files",
  downloads: "download files",
  full_cdp_access: "use advanced page access",
};

/** One-line human sentence for a parked approval, from the engine's
 *  structured fields (never from page content). */
function approvalSentence(card: ApprovalRequestCard): string {
  const facet = FACET_LABELS[card.facet] ?? card.facet;
  return `RUKE wants to ${facet} on ${card.origin || "this site"} (${card.action}).`;
}

export function ApprovalCards({
  cards,
  onAnswer,
}: {
  cards: ApprovalRequestCard[];
  onAnswer(id: string, decision: ApprovalDecision): void;
}) {
  if (cards.length === 0) return null;
  return (
    <div className="bp-cards" role="group" aria-label="Browser permission requests">
      {cards.map((c) => (
        <div key={c.id} className="bp-card" data-testid={`approval-card-${c.id}`}>
          <div className="bp-card-head">
            <ShieldAlert size={14} aria-hidden />
            <span className="bp-card-title">Permission needed</span>
          </div>
          <p className="bp-card-text">{approvalSentence(c)}</p>
          {c.url && <p className="bp-card-url">{c.url}</p>}
          <div className="bp-card-actions">
            <button className="bp-btn bp-btn-primary" onClick={() => onAnswer(c.id, "accept")}>
              Accept
            </button>
            <button className="bp-btn" onClick={() => onAnswer(c.id, "always_allow")}>
              Always allow
            </button>
            <button className="bp-btn" onClick={() => onAnswer(c.id, "decline")}>
              Decline
            </button>
            <button className="bp-btn bp-btn-danger" onClick={() => onAnswer(c.id, "block")}>
              Block
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

const REASON_HINTS: Record<string, string> = {
  authentication: "RUKE paused so you can sign in.",
  captcha: "This page asked for a human check — RUKE stopped.",
  user_requested: "You asked RUKE to hand this tab over.",
  other: "RUKE handed this tab to you.",
};

export function takeoverSentence(reason: string): string {
  return REASON_HINTS[reason] ?? REASON_HINTS.other;
}

function AuthHandoffCard({
  card,
  onAnswer,
}: {
  card: AuthHandoffRequestCard;
  onAnswer(id: string, answer: AuthHandoffAnswer): void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [selectedOption, setSelectedOption] = useState<string | undefined>(
    card.options?.[0]?.id,
  );
  const fields = authVisibleFields(card, selectedOption);
  const missingRequired = fields.some(
    (f) => f.required !== false && !(values[f.id] ?? "").trim(),
  );
  // QR-only asks need no typed values; otherwise every required field
  // must be filled before the engine will be told to proceed.
  const canProceed = !!card.qr_code || !missingRequired;

  const proceed = () => {
    const answer: AuthHandoffAnswer = { action: "proceed" };
    const filled: Record<string, string> = {};
    for (const f of fields) if (values[f.id]) filled[f.id] = values[f.id];
    if (Object.keys(filled).length) answer.values = filled;
    if (selectedOption) answer.selected_option = selectedOption;
    onAnswer(card.id, answer);
  };

  return (
    <div className="bp-card" data-testid={`auth-card-${card.id}`}>
      <div className="bp-card-head">
        <KeyRound size={14} aria-hidden />
        <span className="bp-card-title">Sign-in request</span>
        <button
          className="bp-icon bp-card-x"
          aria-label="Dismiss sign-in request"
          onClick={() => onAnswer(card.id, { action: "cancel" })}
        >
          <X size={13} />
        </button>
      </div>
      <p className="bp-card-text">
        RUKE asked to sign in on {card.origin}. Credentials you type here go
        straight to the page — RUKE never sees them.
      </p>
      {card.account_identifier && (
        <p className="bp-card-url">Signing in as {card.account_identifier}</p>
      )}
      {card.qr_code && (
        <p className="bp-card-text">
          The page shows a QR code — scan it with your device, then accept.
        </p>
      )}
      {card.options && card.options.length > 0 && (
        <div className="bp-auth-options" role="radiogroup" aria-label="Sign-in method">
          {card.options.map((o) => (
            <label key={o.id} className="bp-auth-option">
              <input
                type="radio"
                name={`auth-option-${card.id}`}
                checked={selectedOption === o.id}
                onChange={() => setSelectedOption(o.id)}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
      <div className="bp-auth-fields">
        {fields.map((f) => (
          <label key={f.id} className="bp-auth-field">
            <span>{f.label}</span>
            <input
              className="bp-omni"
              type={f.type === "password" ? "password" : "text"}
              name={`auth-value-${card.id}-${f.id}`}
              autoComplete={f.autocomplete ?? "off"}
              aria-label={f.label}
              value={values[f.id] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      {card.has_otp && (
        <p className="bp-card-text">This site may ask for a one-time code.</p>
      )}
      <div className="bp-card-actions">
        <button
          className="bp-btn bp-btn-primary"
          disabled={!canProceed}
          onClick={proceed}
        >
          Sign in
        </button>
        <button className="bp-btn" onClick={() => onAnswer(card.id, { action: "decline" })}>
          Decline
        </button>
      </div>
    </div>
  );
}

export function AuthHandoffCards({
  cards,
  onAnswer,
}: {
  cards: AuthHandoffRequestCard[];
  onAnswer(id: string, answer: AuthHandoffAnswer): void;
}) {
  if (cards.length === 0) return null;
  return (
    <div className="bp-cards" role="group" aria-label="Browser sign-in requests">
      {cards.map((c) => (
        <AuthHandoffCard key={c.id} card={c} onAnswer={onAnswer} />
      ))}
    </div>
  );
}

/* ── Phase 12: parked annotation cards ──────────────────────────────────── */

/**
 * Comment cards parked on the panel (Browser Use, Phase 12). The engine
 * never pushes these — they come from the human's "Comment on
 * selection" capture (anchor set) or a site-initiated
 * `open_annotation` frame through the page-runtime bridge (detail set,
 * anchor null). Nothing reaches the model until the human clicks
 * "Add to chat": the card is where human intent is written down, and
 * the composer grammar (annotationPrompt) wraps the page details under
 * an explicit untrusted-evidence marker.
 */
function AnnotationCardView({
  card,
  onAdd,
  onDismiss,
}: {
  card: AnnotationCard;
  onAdd(id: string, comment: string): void;
  onDismiss(id: string): void;
}) {
  const [comment, setComment] = useState("");
  const anchor = card.anchor;
  const preview = anchor?.selectedText
    ? `“${anchor.selectedText.length > 120 ? `${anchor.selectedText.slice(0, 120)}…` : anchor.selectedText}”`
    : anchor
      ? `a spot on “${anchor.title || anchor.pageUrl}”`
      : "a comment the page itself asked for";
  return (
    <div className="bp-card" data-testid={`annotation-card-${card.id}`}>
      <div className="bp-card-head">
        <MessageSquareText size={14} aria-hidden />
        <span className="bp-card-title">Browser comment</span>
        <button
          className="bp-icon bp-card-x"
          aria-label="Dismiss comment"
          onClick={() => onDismiss(card.id)}
        >
          <X size={13} />
        </button>
      </div>
      <p className="bp-card-text">
        Commenting on {preview}. Your words become the instruction; the
        page details travel as marked untrusted evidence.
      </p>
      {anchor && <p className="bp-card-url">{anchor.pageUrl}</p>}
      <textarea
        className="bp-omni"
        rows={3}
        aria-label={`Comment for tab ${card.tab_id}`}
        placeholder="What should change here?"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="bp-card-actions">
        <button
          className="bp-btn bp-btn-primary"
          disabled={!comment.trim()}
          onClick={() => onAdd(card.id, comment.trim())}
        >
          Add to chat
        </button>
      </div>
    </div>
  );
}

export function AnnotationCards({
  cards,
  onAddToChat,
  onDismiss,
}: {
  cards: AnnotationCard[];
  onAddToChat(id: string, comment: string): void;
  onDismiss(id: string): void;
}) {
  if (cards.length === 0) return null;
  return (
    <div className="bp-cards" role="group" aria-label="Browser comments">
      {cards.map((c) => (
        <AnnotationCardView key={c.id} card={c} onAdd={onAddToChat} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
