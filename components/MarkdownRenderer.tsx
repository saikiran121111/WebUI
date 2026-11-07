"use client";
import {
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeBlock from "./render/CodeBlock";
import MarkdownTable from "./render/MarkdownTable";
import FenceRouter from "./render/FenceRouter";
import { looksLikeTree, looksLikeTreeStart } from "../lib/render/treeParse";
import { containsMath } from "../lib/render/mathDetect";
import type { RendererMode } from "../lib/decision/types";
import { rehypeCitations } from "./render/citations";
import { CitationPill } from "./web-results/CitationPreview";

export interface RenderContextValue {
  streaming: boolean;
  onSend?: (text: string) => void;
  allowInteractive: boolean;
  decisionMode?: RendererMode | null;
}

export const RenderContext = createContext<RenderContextValue>({
  streaming: false,
  allowInteractive: true,
});

export interface MarkdownRendererProps {
  content: string;
  streaming?: boolean;
  onSend?: (text: string) => void;
  allowInteractive?: boolean;
  decisionMode?: RendererMode | null;
  citationMap?: Record<string, { url: string; title: string; domain: string; publishedAt?: string }>;
}

interface MathModule {
  mathPlugins(): {
    remarkPlugins: unknown[];
    rehypePlugins: unknown[];
  };
}

/**
 * Central markdown pipeline.  Fenced blocks are routed through FenceRouter;
 * math plugins load only when TeX delimiters are actually present.
 * Raw model HTML is never rendered: react-markdown ignores it by default.
 *
 * The component is wrapped in `React.memo` so completed messages in the
 * chat history never re-render while the latest assistant message streams.
 */
export default memo(function MarkdownRenderer({
  content,
  streaming = false,
  onSend,
  allowInteractive = true,
  decisionMode,
  citationMap,
}: MarkdownRendererProps) {
  const [mathMod, setMathMod] = useState<MathModule | null>(null);

  useEffect(() => {
    if (mathMod || !containsMath(content)) return;
    let active = true;
    import("../lib/render/math")
      .then(mod => { if (active) setMathMod(mod); })
      .catch(() => { /* math stays as plain text if the bundle fails */ });
    return () => { active = false; };
  }, [content, mathMod]);

  const plugins = useMemo(() => {
    const base: unknown[] = [remarkGfm];
    const after: unknown[] = [];
    if (mathMod) {
      const math = mathMod.mathPlugins();
      base.push(...math.remarkPlugins);
      after.push(...math.rehypePlugins);
    }
    if (citationMap && Object.keys(citationMap).length > 0) {
      after.push(rehypeCitations(citationMap as any));
    }
    return {
      remarkPlugins: base,
      rehypePlugins: (after.length ? after : undefined) as unknown[] | undefined,
    };
  }, [mathMod, citationMap]);

  const options = useMemo<RenderContextValue>(
    () => ({ streaming, onSend, allowInteractive, decisionMode }),
    [streaming, onSend, allowInteractive, decisionMode],
  );

  const source = useMemo(
    () => (streaming ? stabilizeStreamingTables(content) : content),
    [content, streaming],
  );

  return (
    <RenderContext.Provider value={options}>
      <ReactMarkdown
        remarkPlugins={plugins.remarkPlugins as never[]}
        rehypePlugins={plugins.rehypePlugins as never[] | undefined}
        components={MD_COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </RenderContext.Provider>
  );
});

/**
 * Stable element types for the markdown pipeline.  These renderers MUST live
 * at module scope: an inline object in the JSX would recreate every function
 * identity on each render, and React treats a changed element TYPE as a full
 * unmount+remount of the subtree.  That silently wiped the internal state of
 * every interactive fence (chart selection, mermaid playback, KPI
 * sliders) on any unrelated page re-render — violating the "message tree is
 * stable between commits" contract (project standards §5.3).  None of these
 * renderers capture component-scope state; `table` reads context as a
 * component, which is legal regardless of where the function is declared.
 */
const MD_COMPONENTS = {
  pre({ children }: { children?: ReactNode }) {
    return <FenceRouter>{children}</FenceRouter>;
  },
  code({ node, className, children, ...props }: { node?: unknown; className?: string; children?: ReactNode }) {
    void node;
    return <code className={className} {...props}>{children}</code>;
  },
  table({ children }: { children?: ReactNode }) {
    const { onSend: send } = useContext(RenderContext);
    return <MarkdownTable onSend={send}>{children}</MarkdownTable>;
  },
  a({ children, href }: { children?: ReactNode; href?: string }) {
    const external = !!href && /^https?:\/\//i.test(href);
    return (
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        className="md-link"
      >
        {children}
      </a>
    );
  },
  img({ node, src, alt, ...props }: { node?: unknown; src?: string; alt?: string }) {
    void node;
    return <img src={src} alt={alt ?? ""} loading="lazy" className="md-image" {...props} />;
  },
  blockquote({ children }: { children?: ReactNode }) {
    return <blockquote className="md-quote">{children}</blockquote>;
  },
  hr() {
    return <hr className="md-hr" />;
  },
  // P5 §67: the pill keeps its exact DOM contract (data-testid, data-citation,
  // href, hover classes) and gains the hover/focus preview popover through
  // CitationPill — existing vitest/Playwright locators still pass.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...({ citation(props: any) {
    return (
      <CitationPill
        sourceId={props["data-source"] as string}
        url={props["data-url"] as string}
        title={props["data-title"] as string}
        domain={props["data-domain"] as string}
        publishedAt={props["data-published-at"] as string | undefined}
      />
    );
  } } as any),
};

/**
 * GFM only recognizes a table once the `| --- | --- |` delimiter row has
 * fully arrived.  While streaming, synthesize the missing or half-streamed
 * tail delimiter row so the table renders as a table the moment its header
 * line starts arriving.  Only streaming content is touched.
 */
function stabilizeStreamingTables(content: string): string {
  if ((content.match(/^```/gm)?.length ?? 0) % 2 === 1) return content;
  const lines = content.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  if (last < 0) return content;
  const tail = lines[last].trim();
  const isRow = (line: string) => line.startsWith("|");
  const DELIM_COMPLETE = /^\|(?:\s*:?-+:?\s*\|)+$/;
  const DELIM_PARTIAL = /^\|[\s:|-]*$/;
  const delimFor = (row: string): string | null => {
    const cells = row.replace(/^\|/, "").replace(/\|$/, "").split("|").length;
    return cells >= 1 ? `|${" --- |".repeat(cells)}` : null;
  };
  if (last >= 1 && isRow(tail) && DELIM_PARTIAL.test(tail)) {
    const header = lines[last - 1].trim();
    if (!isRow(header) || DELIM_COMPLETE.test(header)) return content;
    const delim = delimFor(header);
    if (!delim) return content;
    lines[last] = delim;
    return lines.join("\n");
  }
  if (isRow(tail) && !DELIM_PARTIAL.test(tail) && (last === 0 || lines[last - 1].trim() === "")) {
    const delim = delimFor(tail);
    if (!delim) return content;
    lines.splice(last + 1, 0, delim);
    return lines.join("\n");
  }
  return content;
}
