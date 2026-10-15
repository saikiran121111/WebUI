/**
 * Math plugin bundle. Dynamically imported only when a message actually
 * contains TeX delimiters, so KaTeX never costs anything on plain messages.
 */
import "katex/dist/katex.min.css";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

export function mathPlugins(): {
  remarkPlugins: unknown[];
  rehypePlugins: unknown[];
} {
  return {
    remarkPlugins: [remarkMath],
    // Each entry is a unified plugin tuple [plugin, options]. Passing the
    // options as a separate array entry makes unified treat it as a preset
    // with neither plugins nor settings and throw "empty preset".
    rehypePlugins: [[rehypeKatex, { throwOnError: false, errorColor: "#e0a3a3", strict: "ignore" }]],
  };
}

export { containsMath } from "./mathDetect";
