// esbuild inject shim (T007): provide a working `import.meta.url` in the CJS
// main bundle. Some workspace modules (e.g. @interleave/db's paths.ts) use
// `import.meta.url`; in a CJS output esbuild would leave it empty and warn. We
// inject this file and `define` `import.meta.url` → `import_meta_url`, so it
// resolves to the real file URL of the running bundle at runtime.
export const import_meta_url = require("node:url").pathToFileURL(__filename).href;
