"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Prism from "prismjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "../lib/utils";

// Lazy-load language components
const LANGUAGE_MODULES: Record<string, () => Promise<any>> = {};
function registerLang(name: string, mod: () => Promise<any>) {
  LANGUAGE_MODULES[name] = mod;
}
registerLang("javascript", async () => { const m = await import("prismjs/components/prism-javascript"); return m.default; });
registerLang("typescript", async () => { const m = await import("prismjs/components/prism-typescript"); return m.default; });
registerLang("tsx", async () => { const m = await import("prismjs/components/prism-tsx"); return m.default; });
registerLang("jsx", async () => { const m = await import("prismjs/components/prism-jsx"); return m.default; });
registerLang("python", async () => { const m = await import("prismjs/components/prism-python"); return m.default; });
registerLang("rust", async () => { const m = await import("prismjs/components/prism-rust"); return m.default; });
registerLang("go", async () => { const m = await import("prismjs/components/prism-go"); return m.default; });
registerLang("java", async () => { const m = await import("prismjs/components/prism-java"); return m.default; });
registerLang("c", async () => { const m = await import("prismjs/components/prism-c"); return m.default; });
registerLang("cpp", async () => { const m = await import("prismjs/components/prism-cpp"); return m.default; });
registerLang("bash", async () => { const m = await import("prismjs/components/prism-bash"); return m.default; });
registerLang("shell", async () => { const m = await import("prismjs/components/prism-bash"); return m.default; });
registerLang("json", async () => { const m = await import("prismjs/components/prism-json"); return m.default; });
registerLang("yaml", async () => { const m = await import("prismjs/components/prism-yaml"); return m.default; });
registerLang("toml", async () => { const m = await import("prismjs/components/prism-toml"); return m.default; });
registerLang("sql", async () => { const m = await import("prismjs/components/prism-sql"); return m.default; });
registerLang("css", async () => { const m = await import("prismjs/components/prism-css"); return m.default; });
registerLang("html", async () => { const m = await import("prismjs/components/prism-markup"); return m.default; });
registerLang("markdown", async () => { const m = await import("prismjs/components/prism-markdown"); return m.default; });
registerLang("diff", async () => { const m = await import("prismjs/components/prism-diff"); return m.default; });

function CodeBlock({ className, children, ...props }: { className?: string; children: React.ReactNode }) {
  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "text";
  const code = String(children).replace(/\n$/, "");
  const [copied, setCopied] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const codeRef = useRef<HTMLElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const load = async () => {
      const loader = LANGUAGE_MODULES[lang] || LANGUAGE_MODULES[lang.toLowerCase()];
      if (loader) {
        await loader();
      }
      setLoaded(true);
    };
    load();
  }, [lang]);

  useEffect(() => {
    if (loaded && codeRef.current && preRef.current) {
      try { Prism.highlightElement(codeRef.current); } catch {}
    }
  }, [loaded, code]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }, [code]);

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{lang}</span>
        <button onClick={handleCopy}
          className="code-block-copy flex items-center gap-1">
          {copied ? <><Check className="w-3 h-3 text-emerald-500" /><span className="text-emerald-500 text-xs">Copied</span></>
            : <><Copy className="w-3 h-3" /><span className="text-xs">Copy</span></>}
        </button>
      </div>
      <div className="code-block-body">
        <pre ref={preRef} className="!m-0 !p-0 !bg-transparent !border-0">
          <code ref={codeRef}
            className={cn("language-" + lang, "block text-[0.8125rem] leading-relaxed whitespace-pre p-4")}
            {...props}>
            {code}
          </code>
        </pre>
      </div>
    </div>
  );
}

export default function MarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          if (className && /language-/.test(className)) {
            return <CodeBlock className={className} {...props}>{children}</CodeBlock>;
          }
          return <code {...props}>{children}</code>;
        },
        pre({ children }) {
          return <>{children}</>;
        },
        table({ children }) {
          return (
            <div className="overflow-x-auto my-4 rounded-lg border border-white/[0.07]">
              <table className="w-full text-left text-sm">{children}</table>
            </div>
          );
        },
        thead({ children }) {
          return <thead className="[&_th]:bg-white/[0.04] [&_th]:border-b [&_th]:border-white/[0.07] [&_th]:font-semibold [&_th]:text-white/90 [&_th]:text-xs">{children}</thead>;
        },
        blockquote({ children }) {
          return (
            <blockquote className="border-l-[3px] border-indigo-400/30 pl-4 py-1 text-white/60">
              {children}
            </blockquote>
          );
        },
        a({ children, href }) {
          return <a href={href} target="_blank" rel="noopener noreferrer"
            className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2 transition-colors">{children}</a>;
        },
        hr() {
          return <hr className="my-6 border-white/[0.07]" />;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
