/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Auto-boot hook: instrumentation.ts warms the web-search cache on
    // server start (required flag on Next 14; native in 15).
    instrumentationHook: true,
    // Tree-shake lucide-react (per-icon ES modules) so unused icons are
    // stripped from the production bundle automatically.
    optimizePackageImports: ["lucide-react"],
    // Native/binary server deps used by the file-extraction routes. Keeping
    // them external stops webpack from trying to bundle ffmpeg/onnxruntime.
    serverComponentsExternalPackages: [
      "ffmpeg-static",
      "7zip-bin",
      "node-unrar-js",
      "@huggingface/transformers",
      "onnxruntime-node",
      "unpdf",
      "docx",
      "exceljs",
      "pptxgenjs",
      "playwright",
      "playwright-core",
      "@crawlee/playwright",
      // fingerprint/header packages: header-generator reads
      // data_files/headers-order.json via __dirname — bundling into
      // .next/server/vendor-chunks breaks that relative path (ENOENT).
      "fingerprint-generator",
      "fingerprint-injector",
      "header-generator",
      "got-scraping",
      "impit",
      "youtubei.js",
      "linkedom",
      "tldts",
      // Structured server logging: pino's dynamic requires + pino-pretty's
      // color deps must resolve at runtime, not through the webpack bundle.
      "pino",
      "pino-pretty",
      // Web-search engine native deps: impit's Rust N-API binding +
      // better-sqlite3's C++ binding must load from node_modules, not
      // through the webpack bundle (both are required at runtime).
      "better-sqlite3",
    ],
  },
};

export default nextConfig;
