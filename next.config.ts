import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  // sharp and onnxruntime-web are used server-side only; keep them external to
  // the server bundle. onnxruntime-web's WASM backend loads a companion file
  // by a path computed relative to itself at runtime, which webpack bundling
  // breaks — see the design doc's spike section for the reproduction.
  serverExternalPackages: ["sharp", "onnxruntime-web"],
  // This project has its own lockfile; pin the tracing root to silence the
  // "multiple lockfiles" workspace-root warning.
  outputFileTracingRoot: __dirname,
  webpack: (config) => {
    // konva pulls in an optional native "canvas" module for Node; we only use
    // konva in the browser (dynamic import, ssr:false), so stub it out.
    config.resolve.alias = { ...config.resolve.alias, canvas: false };
    return config;
  },
};

export default withNextIntl(nextConfig);
