"use client";
/**
 * RichResultErrorBoundary.tsx — §59 one-broken-widget law: an exception
 * inside ANY surface component is contained to that widget and swapped
 * for the §59 error surface ("Couldn't load interactive view / Open
 * source"). The rest of the assistant message (prose, citations, other
 * surfaces) keeps rendering.
 */
import { Component, type ReactNode } from "react";
import type { RichResult } from "../../lib/web-search/rich-results";
import { ResultError } from "./ResultChrome";
import { safeUrl, str } from "./resultHelpers";

export class RichResultErrorBoundary extends Component<
  { surface: RichResult; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Deterministic tests assert the fallback; silence keeps browser
    // consoles readable in dev, and the frame's source footer still shows.
    void error;
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const s = this.props.surface;
    const p = (s.payload && typeof s.payload === "object" ? s.payload : {}) as Record<string, unknown>;
    let url = safeUrl(p.url);
    if (!url) {
      for (const a of s.actions ?? []) {
        if (a.type === "open_source") { url = safeUrl(a.url); if (url) break; }
      }
    }
    return <ResultError url={url} text={`Couldn’t load ${str(s.title, 60) ?? s.kind} view.`} />;
  }
}
