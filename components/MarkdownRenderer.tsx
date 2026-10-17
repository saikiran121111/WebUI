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
import MermaidBlock from "./render/MermaidBlock";
import ChartBlock from "./render/ChartBlock";
import WidgetBlock from "./render/WidgetBlock";
import Scene3DBlock from "./render/Scene3DBlock";
import Asset3DBlock from "./render/Asset3DBlock";
import AnatomyBlock from "./render/AnatomyBlock";
import CadBlock from "./render/CadBlock";
import TreeBlock from "./render/TreeBlock";
import MarkdownTable from "./render/MarkdownTable";
import { fenceKind } from "../lib/render/registry";
import { looksLikeTree } from "../lib/render/treeParse";
import { containsMath } from "../lib/render/mathDetect";

interface MathModule {
  mathPlugins(): {
    remarkPlugins: unknown[];
    rehypePlugins: unknown[];
  };
}

interface RenderOptions {
  streaming: boolean;
  onSend?: (text: string) => void;
  /** Nested widget content disables interactive fences (no recursive widgets/charts). */
  allowInteractive: boolean;
}

const RenderContext = createContext<RenderOptions>({ streaming: false, allowInteractive: true });

export interface MarkdownRendererProps {
  content: string;
  streaming?: boolean;
  onSend?: (text: string) => void;
  allowInteractive?: boolean;
}

/**
 * Central markdown pipeline. Fenced blocks are routed through the renderer
 * registry (mermaid / chart / widget / code) at the `pre` level, which fixes
 * the old bug where fences without a language label rendered as inline code.
 * Math plugins (KaTeX) load only when TeX delimiters are actually present.
 * Raw model HTML is never rendered: react-markdown ignores it by default.
 */
export default memo(function MarkdownRenderer({
  content,
  streaming = false,
  onSend,
  allowInteractive = true,
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
    if (!mathMod) return { remarkPlugins: [remarkGfm], rehypePlugins: undefined as unknown[] | undefined };
    const math = mathMod.mathPlugins();
    return {
      remarkPlugins: [remarkGfm, ...math.remarkPlugins],
      rehypePlugins: math.rehypePlugins,
    };
  }, [mathMod]);

  const options = useMemo<RenderOptions>(
    () => ({ streaming, onSend, allowInteractive }),
    [streaming, onSend, allowInteractive],
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
 * GFM only recognizes a table once the `| --- | --- |` delimiter row has
 * fully arrived, so while streaming, the header line sits rendered as raw
 * pipe text for as long as that row takes to type out (~1s for 20+ columns).
 * Synthesize the missing or half-streamed tail delimiter row so the table
 * renders as a table the moment its header line starts arriving. Only
 * streaming content is touched — the finished message parses exactly as
 * written.
 */
function stabilizeStreamingTables(content: string): string {
  if ((content.match(/^```/gm)?.length ?? 0) % 2 === 1) return content; // inside an open code fence
  const lines = content.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  if (last < 0) return content;
  const tail = lines[last].trim();
  const isRow = (line: string) => line.startsWith("|");
  const DELIM_COMPLETE = /^\|(?:\s*:?-+:?\s*\|)+$/;
  const DELIM_PARTIAL = /^\|[\s:|-]*$/; // "|", "| ---", "| :--- | ---" — not yet complete
  const delimFor = (row: string): string | null => {
    const cells = row.replace(/^\|/, "").replace(/\|$/, "").split("|").length;
    return cells >= 1 ? `|${" --- |".repeat(cells)}` : null;
  };
  // The delimiter row itself is mid-stream: replace the tail with a complete
  // one sized to the header line above it. A short `| --- | --- |` can be
  // syntactically complete yet mismatch the (wider) header — remark-gfm then
  // refuses the table — so cell count, not syntax, decides the rewrite.
  if (last >= 1 && isRow(tail) && DELIM_PARTIAL.test(tail)) {
    const header = lines[last - 1].trim();
    if (!isRow(header) || DELIM_COMPLETE.test(header)) return content;
    const delim = delimFor(header);
    if (!delim) return content;
    lines[last] = delim;
    return lines.join("\n");
  }
  // The header line itself is the tail (delimiter not started yet): append a
  // synthesized delimiter row after it.
  if (isRow(tail) && !DELIM_PARTIAL.test(tail) && (last === 0 || lines[last - 1].trim() === "")) {
    const delim = delimFor(tail);
    if (!delim) return content;
    lines.splice(last + 1, 0, delim);
    return lines.join("\n");
  }
  return content;
}

const MD_COMPONENTS = {
  pre({ children }: { children?: ReactNode }) {
    return <FencedBlock>{children}</FencedBlock>;
  },
  code({ node, className, children, ...props }: { node?: unknown; className?: string; children?: ReactNode }) {
    // Fenced code is handled by the pre override; anything reaching here is inline.
    // `node` (the hast node) is stripped so it never reaches the DOM.
    void node;
    return <code className={className} {...props}>{children}</code>;
  },
  table({ children }: { children?: ReactNode }) {
    // Row-level "Ask AI about this row" needs onSend — context resolves
    // here because react-markdown renders these overrides as components.
    const { onSend } = useContext(RenderContext);
    return <MarkdownTable onSend={onSend}>{children}</MarkdownTable>;
  },
  a({ children, href }: { children?: ReactNode; href?: string }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="md-link">
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
};

/**
 * Extracts the fenced `code` child react-markdown places inside `pre`,
 * reads its language, and routes to the right renderer. Falls back to a
 * plain code block when there is no language or the language is unknown —
 * never mislabeled, never rendered as inline code.
 */
function FencedBlock({ children }: { children?: ReactNode }) {
  const { streaming, onSend, allowInteractive } = useContext(RenderContext);

  // react-markdown renders the inner <code> through our own `code` override,
  // so the child's type is that component — not the string "code".
  const isCodeChild = (child: ReactNode) =>
    isValidElement(child) && (child.type === "code" || child.type === MD_COMPONENTS.code);

  const codeChild = Array.isArray(children)
    ? children.find(isCodeChild)
    : isCodeChild(children)
      ? children
      : null;

  if (!codeChild) return <pre className="md-pre">{children}</pre>;

  const childProps = codeChild.props as { className?: string; children?: ReactNode };
  const language = extractLanguage(childProps.className);
  const source = flattenText(childProps.children).replace(/\n$/, "");

  const kind = fenceKind(language);
  if (kind === "mermaid" && allowInteractive) return <MermaidBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "chart" && allowInteractive) return <ChartBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "scene3d" && allowInteractive) return <Scene3DBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "asset3d" && allowInteractive) return <Asset3DBlock source={source} streaming={streaming} />;
  if (kind === "anatomy" && allowInteractive) return <AnatomyBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "cad" && allowInteractive) return <CadBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "widget" && allowInteractive) return <WidgetBlock source={source} streaming={streaming} onSend={onSend} />;
  // Box-drawing trees arrive in plain/text fences — detect by content, not label.
  if (kind === "code" && looksLikeTree(source)) return <TreeBlock source={source} />;
  return <CodeBlock code={source} lang={language} streaming={streaming} />;
}

function extractLanguage(className?: string): string {
  const match = /language-([^\s]+)/.exec(className ?? "");
  return match ? match[1] : "";
}

function flattenText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement(node)) return flattenText((node.props as { children?: ReactNode }).children);
  return "";
}
