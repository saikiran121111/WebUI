/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Auto-boot hook: instrumentation.ts warms the Decision Engine on server
    // start (required flag on Next 14; native in 15).
    instrumentationHook: true,
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
      // Structured server logging: pino's dynamic requires + pino-pretty's
      // color deps must resolve at runtime, not through the webpack bundle.
      "pino",
      "pino-pretty",
      // Web-search engine native deps: impit's Rust N-API binding +
      // better-sqlite3's C++ binding must load from node_modules, not
      // through the webpack bundle (both are required at runtime).
      "impit",
      "better-sqlite3",
      // linkedom's CJS parser must also resolve at runtime.
      "linkedom",
    ],
  },
};

export default nextConfig;
