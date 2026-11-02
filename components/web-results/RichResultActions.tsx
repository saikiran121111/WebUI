"use client";
/**
 * RichResultActions.tsx — the §40 action law, executed in exactly one
 * place. The union was validated twice (server sanitizer + client re-check);
 * this dispatcher still treats every field defensively and NEVER executes
 * an arbitrary model-supplied URL or script — open_source is the only
 * navigation, gated by the safe-URL law, and every consequential action
 * (§41) is an entry point a human presses, never an auto-execution.
 */
import { memo, useCallback } from "react";
import type { RichAction, RichResult } from "../../lib/web-search/rich-results";
import { findItemById, hostOf, safeUrl, str, duration } from "./resultHelpers";
import { useRichResultCtx, type LightboxMedia } from "./richResultContext";

function actionLabel(a: RichAction): { text: string; aria: string } {
  switch (a.type) {
    case "open_source": return { text: hostOf(a.url) || "Open source", aria: `Open source ${hostOf(a.url) || a.url}` };
    case "issue_followup": return { text: "Follow-up", aria: `Send follow-up: ${str(a.prompt, 120) ?? ""}` };
    case "open_detail": return { text: "Details", aria: "Open details" };
    case "lightbox": return { text: "Enlarge", aria: "Open enlarged view" };
    case "fullscreen": return { text: "Fullscreen", aria: "Open fullscreen view" };
    case "pip": return { text: "Pop out", aria: "Open picture-in-picture view" };
    case "compare": return { text: "Compare", aria: "Open comparison" };
    case "select_map_pin": return { text: "Focus pin", aria: `Focus map pin ${a.id}` };
    case "seek_media": return { text: `Jump to ${duration(a.seconds) ?? a.seconds}`, aria: `Seek media to ${duration(a.seconds) ?? a.seconds}` };
    case "prepare_action": return { text: "Unavailable", aria: "Action not available in this app" };
  }
}

export const RichResultActions = memo(function RichResultActions({
  surface,
}: {
  surface: RichResult;
}) {
  const ctx = useRichResultCtx();
  const actions = surface.actions ?? [];
  if (!actions.length) return null;

  const dispatch = useCallback((a: RichAction) => {
    switch (a.type) {
      case "open_source": {
        // Defense in depth: re-verify at click time (§75 javascript: reject).
        const href = safeUrl(a.url);
        if (href) window.open(href, "_blank", "noopener,noreferrer");
        return;
      }
      case "issue_followup": {
        const prompt = str(a.prompt, 2000);
        if (prompt && ctx?.onFollowUp) ctx.onFollowUp(prompt);
        return;
      }
      case "open_detail":
      case "fullscreen":
      case "pip": {
        if (!ctx) return;
        ctx.openOverlay({
          surface,
          itemId: a.type === "open_detail" && a.targetId !== surface.id ? a.targetId : undefined,
          mode: a.type === "open_detail" ? "detail" : a.type === "fullscreen" ? "fullscreen" : "pip",
        });
        return;
      }
      case "compare": {
        if (!ctx) return;
        // Comparison detail: the payload items the ids point at, side by
        // side — the overlay reads structured rows, never rebuilt prose.
        ctx.openOverlay({ surface, itemId: a.ids.join(","), mode: "detail" });
        return;
      }
      case "select_map_pin":
        ctx?.selectPin?.(surface.id, a.id);
        return;
      case "seek_media":
        if (Number.isFinite(a.seconds) && a.seconds >= 0) ctx?.seekMedia?.(surface.id, a.seconds);
        return;
      case "lightbox": {
        const item = findItemById(surface.payload as Record<string, unknown>, a.targetId);
        const url = safeUrl(item?.url) ?? safeUrl(item?.thumb);
        if (!url || !ctx) return;
        const media: LightboxMedia[] = [{ url, alt: str(item?.title, 200), creditDomain: str(item?.sourceRef, 80) }];
        ctx.openLightbox(media, 0);
        return;
      }
      case "prepare_action":
        // §41 consequential action: entry points only. The repo has no
        // transaction executor, so this is an honest no-op (button disabled).
        return;
    }
  }, [ctx, surface]);

  return (
    <div className="wr-action-row">
      {actions.map((a, i) => {
        const { text, aria } = actionLabel(a);
        const disabled = a.type === "prepare_action"
          || (a.type === "issue_followup" && !ctx?.onFollowUp);
        return (
          <button key={i} type="button"
            className={`wr-action${a.type === "open_source" ? " wr-action--primary" : ""}`}
            aria-label={aria} disabled={disabled}
            title={a.type === "issue_followup" ? str(a.prompt, 200) : undefined}
            onClick={() => dispatch(a)}>
            {text}
          </button>
        );
      })}
    </div>
  );
});
