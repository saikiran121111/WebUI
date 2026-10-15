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
import MarkdownTable from "./render/MarkdownTable";
import { fenceKind } from "../lib/render/registry";
import { containsMath } from "../lib/render/mathDetect";

interface MathModule {
  mathPlugins(): {
    remarkPlugins: unknown[];
    rehypePlugins: [unknown, Record<string, unknown>];
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
      rehypePlugins: [math.rehypePlugins[0], math.rehypePlugins[1]] as unknown[],
    };
  }, [mathMod]);

  const options = useMemo<RenderOptions>(
    () => ({ streaming, onSend, allowInteractive }),
    [streaming, onSend, allowInteractive],
  );

  return (
    <RenderContext.Provider value={options}>
      <ReactMarkdown
        remarkPlugins={plugins.remarkPlugins as never[]}
        rehypePlugins={plugins.rehypePlugins as never[] | undefined}
        components={MD_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </RenderContext.Provider>
  );
});

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
    return <MarkdownTable>{children}</MarkdownTable>;
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
  if (kind === "mermaid" && allowInteractive) return <MermaidBlock source={source} streaming={streaming} />;
  if (kind === "chart" && allowInteractive) return <ChartBlock source={source} streaming={streaming} />;
  if (kind === "widget" && allowInteractive) return <WidgetBlock source={source} streaming={streaming} onSend={onSend} />;
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
