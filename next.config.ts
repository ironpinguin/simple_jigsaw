import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp is used server-side only; keep it external to the server bundle.
  serverExternalPackages: ["sharp"],
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

export default nextConfig;
