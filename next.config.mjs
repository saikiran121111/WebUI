/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
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
    ],
  },
};

export default nextConfig;
