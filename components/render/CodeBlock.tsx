"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, AlertCircle, WrapText, ListOrdered, ChevronDown, ChevronUp, Download } from "lucide-react";
import { highlightCode } from "../../lib/render/highlight";
import { resolveLanguage } from "../../lib/render/languages";
import { copyText } from "../../lib/render/clipboard";

const STREAM_HIGHLIGHT_INTERVAL_MS = 200;
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

  // Throttle, never debounce: SSE chunks arrive faster than any fixed delay,
  // so a debounced timer is always cleared before it fires and colors would
  // only appear when the fence closes. Highlight immediately once the
  // interval has elapsed; otherwise schedule the trailing run — the final
  // chunk's timer is never cleared, so the last highlight always lands.
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
    const sinceLast = Date.now() - lastHighlightAt.current;
    const wait = streaming ? Math.max(0, STREAM_HIGHLIGHT_INTERVAL_MS - sinceLast) : 0;
    const run = () => {
      lastHighlightAt.current = Date.now();
      const seq = ++highlightSeq.current;
      void highlightCode(code, lang).then(result => {
        // During a fast stream seq advances before this resolves; discarding
        // the result then would leave the block plain until the stream pauses
        // (the exact UX bug this throttle exists to fix). Paint it as long as
        // nothing newer has already painted — never regress to older code.
        if (!cancelled && seq >= appliedSeq.current) {
          appliedSeq.current = seq;
          setHtml(result?.html ?? null);
        }
      });
    };
    if (wait === 0) {
      run();
      return () => { cancelled = true; };
    }
    const timer = setTimeout(run, wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
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
            {copyStatus === "copied" ? <Check className="w-3.5 h-3.5 text-emerald-400" />
              : copyStatus === "failed" ? <AlertCircle className="w-3.5 h-3.5 text-red-400" />
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
