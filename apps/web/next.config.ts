import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  cacheComponents: true,
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  outputFileTracingIncludes: {
    "/api/project-files/*": ["../../data/kiewit/bp-tunnel/*"],
    "/api/pdf-worker": ["../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs"],
  },
};

export default nextConfig;
