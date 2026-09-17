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
    // Node 26 is the first release to expose its own `localStorage` global by
    // default (22 and 24 did not). It reads as `undefined` unless
    // `--localstorage-file` is given, and it wins over the one jsdom installs —
    // so on Node 26 `window.localStorage` was undefined and all 27 component
    // tests that touch storage failed. Turning Node's Web Storage off hands the
    // global back to jsdom, whose `Storage.prototype` those tests spy on; a
    // replacement Storage from a second JSDOM would be a different realm's
    // class and would break the spy instead. See #75.
    poolOptions: { forks: { execArgv: ["--no-experimental-webstorage"] } },
    // Split by directory rather than per-file docblocks: a component test that
    // forgets one fails confusingly, and the pure lib tests keep node's faster
    // startup.
    projects: [
      {
        extends: true,
        test: {
          name: "lib",
          environment: "node",
          // Deliberately not UTC. CI runners are UTC, and a helper that formats
          // dates in the *runtime's* zone is indistinguishable from one that
          // pins UTC when the runtime already is UTC — which is how the
          // hydration bug in #38 stayed invisible to a green suite. Anything
          // that leans on the ambient zone now fails here first.
          env: { TZ: "America/New_York" },
          include: ["lib/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "components",
          environment: "jsdom",
          include: ["components/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: { name: "api", environment: "node", include: ["app/api/**/*.test.ts"] },
      },
      {
        // Server Components under app/[locale] are plain async functions —
        // same node/mock style as the api project, just a different route
        // under app/ that wasn't covered by any existing glob.
        extends: true,
        test: { name: "pages", environment: "node", include: ["app/[locale]/**/*.test.tsx"] },
      },
    ],
  },
});
