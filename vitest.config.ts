import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // Next compiles JSX itself, so tsconfig keeps `jsx: "preserve"`. The
  // transformer cannot consume that and would leave the JSX in place, so the
  // automatic runtime the components expect has to be asked for here.
  //
  // This was `esbuild: { jsx: "automatic" }` until vitest 5, which brought
  // Vite 8 and with it Rolldown/Oxc in place of esbuild: the `esbuild` key is
  // gone, and Oxc takes `'preserve'` or a JsxOptions object rather than a bare
  // string, so the runtime moves one level down.
  oxc: { jsx: { runtime: "automatic" } },
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
    //
    // vitest 5 flattened `poolOptions.forks.execArgv` to a plain `execArgv`.
    execArgv: ["--no-experimental-webstorage"],
    // Deliberately not UTC, and deliberately here rather than per project. CI
    // runners are UTC, and code that formats dates in the *runtime's* zone is
    // indistinguishable from code that pins UTC when the runtime already is —
    // which is how the hydration bug in #38 stayed invisible to a green suite.
    // At the root it covers every project, so a date call site added under
    // app/ is held to the same standard as the ones in lib/ and components/.
    // The admin fixtures sit either side of midnight in this zone on purpose:
    // a call site that drops `timeZone: "UTC"` renders the wrong day (#55).
    env: { TZ: "America/New_York" },
    // Split by directory rather than per-file docblocks: a component test that
    // forgets one fails confusingly, and the pure lib tests keep node's faster
    // startup.
    projects: [
      {
        extends: true,
        test: {
          name: "lib",
          environment: "node",
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
        test: {
          name: "pages",
          environment: "node",
          include: ["app/[locale]/**/*.test.tsx"],
          // ...except the "use client" ones, which need a DOM. Same reasoning as
          // the split above: the suffix decides, not a docblock someone forgets.
          exclude: [...configDefaults.exclude, "**/*.client.test.tsx"],
        },
      },
      {
        // Not every page under app/ is a Server Component: a few are "use
        // client" and need jsdom exactly like the components project. The
        // `.client.test.tsx` suffix is what keeps them out of `pages` above.
        extends: true,
        test: {
          name: "pages-client",
          environment: "jsdom",
          include: ["app/**/*.client.test.tsx"],
        },
      },
    ],
  },
});
