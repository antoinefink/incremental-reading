import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const siteRoot = import.meta.dirname;
const repoRoot = resolve(import.meta.dirname, "../..");
const designRoot = resolve(repoRoot, "design");
const fontRoots = [
  dirname(require.resolve("@fontsource/ibm-plex-sans/package.json")),
  dirname(require.resolve("@fontsource/ibm-plex-serif/package.json")),
  dirname(require.resolve("@fontsource/ibm-plex-mono/package.json")),
];
const host = process.env.INTERLEAVE_SITE_HOST ?? "127.0.0.1";

export default defineConfig({
  server: {
    host,
    port: 5174,
    strictPort: true,
    fs: {
      // Allow shared tokens and local font files without exposing the repo root.
      allow: [siteRoot, designRoot, ...fontRoots],
    },
  },
  preview: {
    host,
    port: 4174,
    strictPort: true,
  },
});
