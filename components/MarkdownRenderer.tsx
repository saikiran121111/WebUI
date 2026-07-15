"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighterPrism } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, Check } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";

const prismTheme = oneDark;

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

// Code Block with copy button
function CodeBlock({
  className,
  children,
  ...props
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || "");
  const language = match ? match[1] : "text";
  const code = String(children).replace(/\n$/, "");

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [code]);

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language}</span>
        <button onClick={handleCopy} className="code-block-copy" aria-label={copied ? "Copied!" : "Copy code"}>
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-500" />
              <span className="text-emerald-500">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <div className="code-block-body">
        <SyntaxHighlighterPrism
          language={language}
          style={prismTheme}
          customStyle={{
            margin: 0,
            padding: 0,
            background: "transparent",
            fontSize: "0.8125rem",
            lineHeight: 1.7,
            overflow: "auto",
          }}
          wrapLongLines={false}
          showLineNumbers={false}
          PreTag="div"
          {...props}
        >
          {code}
        </SyntaxHighlighterPrism>
      </div>
    </div>
  );
}

function formatChildren(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(formatChildren).join("");
  if (children && typeof children === "object" && "props" in children) {
    const child = children as { props?: { children?: React.ReactNode } };
    return child.props?.children ? formatChildren(child.props.children) : "";
  }
  return String(children);
}

export default function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={cn("prose", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            if (className && /language-/.test(className)) {
              return <CodeBlock className={className} {...props}>{children}</CodeBlock>;
            }
            return (
              <code {...props}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-4 rounded-lg border border-[var(--code-border)]">
                <table className="w-full text-left text-sm">{children}</table>
              </div>
            );
          },
          thead({ children }) {
            return <thead className="[&_th]:bg-[var(--accent)] [&_th]:border-[var(--border)] [&_th]:font-semibold [&_th]:text-[var(--foreground)]">{children}</thead>;
          },
          blockquote({ children }) {
            return (
              <blockquote
                className={cn(
                  "border-l-[3px] border-[var(--border)] pl-4 italic",
                  "text-[var(--muted)]"
                )}
              >
                {children}
              </blockquote>
            );
          },
          a({ children, href }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--tw-prose-links, #2563eb)] underline underline-offset-2 transition-opacity hover:opacity-80"
              >
                {children}
              </a>
            );
          },
          hr() {
            return <hr className="my-6 border-[var(--border)]" />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
