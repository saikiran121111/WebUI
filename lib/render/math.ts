/**
 * Math plugin bundle. Dynamically imported only when a message actually
 * contains TeX delimiters, so KaTeX never costs anything on plain messages.
 */
import "katex/dist/katex.min.css";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

export function mathPlugins(): {
  remarkPlugins: unknown[];
  rehypePlugins: [unknown, Record<string, unknown>];
} {
  return {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex, { throwOnError: false, errorColor: "#e0a3a3", strict: "ignore" }],
  };
}

export { containsMath } from "./mathDetect";
