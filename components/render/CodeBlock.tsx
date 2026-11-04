"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, AlertCircle, WrapText, ListOrdered, ChevronDown, ChevronUp, Download } from "lucide-react";
import { highlightCode } from "../../lib/render/highlight";
import { resolveLanguage } from "../../lib/render/languages";
import { copyText } from "../../lib/render/clipboard";

/**
 * Throttle interval for highlighting an ACTIVELY STREAMING fence.  A local
 * model emits tokens faster than any pure debounce can settle (the old
 * 150 ms debounce reset on every chunk and Shiki never ran until the fence
 * closed — that is why colors appeared only after generation finished).
 * Colors must land DURING generation, so highlighting is throttled, not
 * debounced: at most one Shiki pass per interval while tokens keep flowing,
 * plus one immediate pass when streaming ends.  400 ms ≈ 2.5 Shiki passes
 * per second worst-case, which keeps the rAF-batched stream cost flat.
 */
const STREAM_HIGHLIGHT_INTERVAL_MS = 400;
const MAX_STREAM_HIGHLIGHT_CHARS = 10_000;
const COLLAPSE_AFTER_LINES = 24;

interface CodeBlockProps {
  code: string;
  lang: string;
  streaming?: boolean;
}

/**
 * Fenced code block: Shiki-highlighted body, header with honest language
 * label and working controls. Copy always uses the canonical `code` string,
 * never the rendered HTML, so pasted output is character-for-character exact.
 */
export default memo(function CodeBlock({ code, lang, streaming = false }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [lineNumbers, setLineNumbers] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolved = useMemo(() => resolveLanguage(lang), [lang]);
  const lineCount = useMemo(() => code.split("\n").length, [code]);
  const collapsible = lineCount > COLLAPSE_AFTER_LINES;

  // Throttle: while streaming, one Shiki pass per STREAM_HIGHLIGHT_INTERVAL_MS
  // at most (new chunks inside the window piggyback on the scheduled pass).
  // The final chunk (streaming = false) triggers an immediate highlight.
  const lastHighlightAt = useRef(0);
  const highlightSeq = useRef(0);
  const appliedSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    if (!resolved.loader) {
      setHtml(null);
      return;
    }
    // Very long blocks stay plain while streaming, then highlight once done.
    if (streaming && code.length > MAX_STREAM_HIGHLIGHT_CHARS) {
      setHtml(null);
      return;
    }
    const run = () => {
      if (cancelled) return;
      lastHighlightAt.current = Date.now();
      const seq = ++highlightSeq.current;
      void highlightCode(code, lang).then(result => {
        if (!cancelled && seq >= appliedSeq.current) {
          appliedSeq.current = seq;
          setHtml(result?.html ?? null);
        }
      });
    };
    // While actively streaming: throttled — colors keep landing mid-stream.
    if (streaming) {
      const wait = STREAM_HIGHLIGHT_INTERVAL_MS - (Date.now() - lastHighlightAt.current);
      if (wait <= 0) {
        run();
        return () => { cancelled = true; };
      }
      const timer = setTimeout(run, wait);
      return () => { cancelled = true; clearTimeout(timer); };
    }
    // Streaming just ended: highlight immediately with no debounce.
    lastHighlightAt.current = Date.now();
    const seq = ++highlightSeq.current;
    void highlightCode(code, lang).then(result => {
      if (!cancelled && seq >= appliedSeq.current) {
        appliedSeq.current = seq;
        setHtml(result?.html ?? null);
      }
    });
    return () => { cancelled = true; };
  }, [code, lang, resolved.loader, streaming]);

  useEffect(() => () => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
  }, []);

  const flashStatus = useCallback((status: "copied" | "failed") => {
    setCopyStatus(status);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setCopyStatus("idle"), 2000);
  }, []);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(code);
    flashStatus(ok ? "copied" : "failed");
  }, [code, flashStatus]);

  const handleDownload = useCallback(() => {
    const ext = resolved.key ?? "txt";
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `snippet.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }, [code, resolved]);

  const bodyClass = [
    "code-block-body",
    lineNumbers ? "line-numbers" : "",
    wrap ? "code-wrap" : "",
    collapsible && !expanded ? "code-collapsed" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className="code-block" data-testid="code-block" data-lang={resolved.label}>
      <div className="code-block-header">
        <span className="code-block-lang">{resolved.label}</span>
        <div className="code-block-controls">
          {collapsible && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="code-block-ctl"
              aria-label={expanded ? "Collapse code" : "Expand code"}
              title={expanded ? "Collapse" : `Show all ${lineCount} lines`}
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          )}
          <button
            onClick={() => setLineNumbers(v => !v)}
            className={"code-block-ctl" + (lineNumbers ? " is-active" : "")}
            aria-label="Toggle line numbers"
            aria-pressed={lineNumbers}
            title="Line numbers"
          >
            <ListOrdered className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setWrap(v => !v)}
            className={"code-block-ctl" + (wrap ? " is-active" : "")}
            aria-label="Toggle line wrapping"
            aria-pressed={wrap}
            title="Wrap lines"
          >
            <WrapText className="w-3.5 h-3.5" />
          </button>
          {collapsible && (
            <button onClick={handleDownload} className="code-block-ctl" aria-label="Download code" title="Download">
              <Download className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={handleCopy}
            className="code-block-copy"
            aria-label="Copy code"
            data-testid="code-copy-btn"
          >
            {copyStatus === "copied" ? <Check className="w-3.5 h-3.5 text-white/80" />
              : copyStatus === "failed" ? <AlertCircle className="w-3.5 h-3.5 text-white/60" />
                : <Copy className="w-3.5 h-3.5" />}
            <span aria-live="polite" className="text-xs">
              {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Failed" : "Copy"}
            </span>
          </button>
        </div>
      </div>
      <div className={bodyClass} data-testid="code-body">
        {html
          ? <div dangerouslySetInnerHTML={{ __html: html }} />
          : <pre><code>{code}</code></pre>}
      </div>
    </div>
  );
});
