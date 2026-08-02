import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Next compiles JSX itself, so tsconfig keeps `jsx: "preserve"`. esbuild
  // cannot consume that and falls back to `React.createElement`, which nothing
  // imports — the automatic runtime is what the components expect.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    // Split by directory rather than per-file docblocks: a component test that
    // forgets one fails confusingly, and the pure lib tests keep node's faster
    // startup.
    projects: [
      {
        extends: true,
        test: { name: "lib", environment: "node", include: ["lib/**/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "components",
          environment: "jsdom",
          include: ["components/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
