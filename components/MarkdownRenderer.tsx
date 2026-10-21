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
import ThreeCodeBlock from "./render/ThreeCodeBlock";
import TreeBlock from "./render/TreeBlock";
import HtmlArtifactBlock from "./render/HtmlArtifactBlock";
import ResumeBlock from "./render/ResumeBlock";
import DocxBlock from "./render/DocxBlock";
import XlsxBlock from "./render/XlsxBlock";
import PptxBlock from "./render/PptxBlock";
import PowerBiBlock from "./render/PowerBiBlock";
import MarkdownTable from "./render/MarkdownTable";
import { fenceKind } from "../lib/render/registry";
import { looksLikeTree, looksLikeTreeStart } from "../lib/render/treeParse";
import { looksLikeThreeCode } from "../lib/three3d/codeRunner";
import { containsMath } from "../lib/render/mathDetect";
import type { RendererMode } from "../lib/decision/types";
import { rehypeCitations } from "./render/citations";

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
  /** A fence failed at runtime (```threejs code threw in the viewer) — route to auto-repair. */
  onFenceRuntimeError?: (info: { lang: string; body: string; error: string }) => void;
  /** Decision Engine mode of the turn (documentation only since 2026-10-22 —
   * every valid studio fence mounts regardless of the mode). */
  decisionMode?: RendererMode | null;
}

const RenderContext = createContext<RenderOptions>({ streaming: false, allowInteractive: true });

export interface MarkdownRendererProps {
  content: string;
  streaming?: boolean;
  onSend?: (text: string) => void;
  allowInteractive?: boolean;
  onFenceRuntimeError?: (info: { lang: string; body: string; error: string }) => void;
  decisionMode?: RendererMode | null;
  /** Web-research citation map: [S1]…[Sn] markers become clickable pills. */
  citationMap?: Record<string, { url: string; title: string; domain: string; publishedAt?: string }>;
}

/**
 * Interactive renderer kinds — ALL ALLOWED (2026-10-22).
 *
 * Before the in-process routing rewrite, a viewer mounted ONLY when its kind
 * matched the Decision Engine's active_mode — a valid ```xlsx block failed to
 * render when LFM misclassified the turn as standard_chat. The user's
 * decision: whenever the main LLM emits a valid studio fence (xlsx, docx,
 * pptx, cad, scene3d, anatomy, chart, html, mermaid, tree, threejs...),
 * the studio component mounts immediately. `kindAllowed` therefore always
 * returns true; the mode table below stays only as a documentation of which
 * fence belongs to which mode.
 */
const MODE_RENDER_KINDS: Record<RendererMode, string[]> = {
  excel: ["xlsx"],
  docs: ["docx", "resume"],
  pdf: ["html"],
  ppt: ["pptx"],
  "3d_asset": ["scene3d", "asset3d", "threejs"],
  cad_blueprint: ["cad", "anatomy"],
  chart: ["chart", "powerbi", "mermaid"],
  html_render: ["html"],
  standard_chat: [],
};

/**
 * Every fence the main model emits renders, regardless of the turn's
 * decisionMode. `decisionMode` stays on the prop surface (Playwright
 * contract / the x-decision-mode header still travels), it just no longer
 * gates what mounts.
 */
function kindAllowed(kind: string, _decisionMode: RendererMode | null | undefined): boolean {
  void kind;
  void MODE_RENDER_KINDS; // documented table, not a gate
  return true;
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
  onFenceRuntimeError,
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
    // Web-research citation pills: only mount when the content actually
    // carries [S#] markers AND a map is provided — zero work otherwise.
    // This MUST be a rehype (post-mdast→hast) plugin: it emits hast `element`
    // nodes, and remark would hand them to the converter, which discards node
    // types it does not know. That is why every earlier run of the evidence
    // loop reported `citation pills=0` on an answer that contained [S#].
    if (citationMap && Object.keys(citationMap).length > 0) {
      after.push(rehypeCitations(citationMap as any));
    }
    return {
      remarkPlugins: base,
      rehypePlugins: (after.length ? after : undefined) as unknown[] | undefined,
    };
  }, [mathMod, citationMap]);

  const options = useMemo<RenderOptions>(
    () => ({ streaming, onSend, allowInteractive, onFenceRuntimeError, decisionMode }),
    [streaming, onSend, allowInteractive, onFenceRuntimeError, decisionMode],
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
    // Plain link: external targets open in a new tab, everything else renders
    // as-is. (The web-verify era added a "only trust retrieved-source URLs"
    // guard here; it was removed with the ledger — a model-written link is a
    // model-written link, and the [S#] pills are the citation mechanism.)
    const external = !!href && /^https?:\/\//i.test(href);
    return (
      <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} className="md-link">
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
  // Custom citation element emitted by the rehypeCitations plugin: the [S#]
  // pill that opens the source URL. (The per-source verdict badge that used
  // to ride next to it was removed with the web-verify ledger, 2026-10-22:
  // pills are citations, not claims.)
  citation(props: any) {
    const source = props["data-source"] as string;
    const url = props["data-url"] as string;
    const title = props["data-title"] as string;
    return (
      <span className="inline-flex items-center gap-1 align-super" data-testid="citation-pill">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={title}
          data-citation={source}
          className="inline-flex items-center gap-0.5 text-[11px] font-medium
            px-1.5 py-0.5 rounded
            bg-[#38E8FF]/10 text-[#38E8FF]
            hover:bg-[#38E8FF]/20 transition-colors"
        >
          <span>{source}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-70">
            <path d="M7 17 17 7M7 7h10v10" />
          </svg>
        </a>
      </span>
    );
  },
};

/**
 * Extracts the fenced `code` child react-markdown places inside `pre`,
 * reads its language, and routes to the right renderer. Falls back to a
 * plain code block when there is no language or the language is unknown —
 * never mislabeled, never rendered as inline code.
 */
function FencedBlock({ children }: { children?: ReactNode }) {
  const { streaming, onSend, allowInteractive, onFenceRuntimeError, decisionMode } = useContext(RenderContext);

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
  // The Decision Engine's active_mode is the ONLY gate: a viewer mounts when
  // (and only when) its kind matches this turn's mode. Off-mode fences stay
  // plain code no matter what they contain — no cross-mode validation ever.
  const interactive = allowInteractive && kindAllowed(kind, decisionMode);
  const threeOk = allowInteractive && kindAllowed("threejs", decisionMode);
  const treeOk = allowInteractive && kindAllowed("tree", decisionMode);
  const runtimeError = onFenceRuntimeError
    ? (error: string) => onFenceRuntimeError({ lang: "threejs", body: source, error })
    : undefined;
  if (kind === "mermaid" && interactive) return <MermaidBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "chart" && interactive) return <ChartBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "scene3d" && interactive) return <Scene3DBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "asset3d" && interactive) return <Asset3DBlock source={source} streaming={streaming} />;
  if (kind === "anatomy" && interactive) return <AnatomyBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "cad" && interactive) return <CadBlock source={source} streaming={streaming} onSend={onSend} />;
  if (kind === "threejs" && interactive) return <ThreeCodeBlock source={source} streaming={streaming} onSend={onSend} onRuntimeError={runtimeError} />;
  if (kind === "widget" && interactive) return <WidgetBlock source={source} streaming={streaming} onSend={onSend} />;
  // Document modality fences (PHASE 2–5): preview-before-download viewers.
  if (kind === "html" && interactive) return <HtmlArtifactBlock source={source} streaming={streaming} />;
  if (kind === "resume" && interactive) return <ResumeBlock source={source} streaming={streaming} />;
  if (kind === "docx" && interactive) return <DocxBlock source={source} streaming={streaming} />;
  if (kind === "xlsx" && interactive) return <XlsxBlock source={source} streaming={streaming} />;
  if (kind === "pptx" && interactive) return <PptxBlock source={source} streaming={streaming} />;
  if (kind === "powerbi" && interactive) return <PowerBiBlock source={source} streaming={streaming} />;
  // Box-drawing trees arrive in plain/text fences — detect by content, not
  // label; the "tree" render kind (standard_chat) is the mode gate. While
  // streaming, looksLikeTreeStart fires on the first complete branch line
  // and is monotonic, so the fence mounts as a TreeBlock immediately and
  // never flips back to a code block mid-generation.
  const treeSource = streaming
    ? looksLikeTree(source) || looksLikeTreeStart(source)
    : looksLikeTree(source);
  if (kind === "code" && treeOk && treeSource) return <TreeBlock source={source} />;
  // Executable Three.js arriving in a plain js fence still gets the studio viewer.
  if (kind === "code" && threeOk && looksLikeThreeCode(source)) return <ThreeCodeBlock source={source} streaming={streaming} onSend={onSend} onRuntimeError={runtimeError} />;
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
