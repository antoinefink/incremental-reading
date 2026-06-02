/**
 * Ambient type for the `pdfjs-dist` legacy worker entry (T064). The package ships
 * the worker as a `.mjs` with no bundled type declaration; we import its
 * `WorkerMessageHandler` to register a MAIN-THREAD worker handler (see
 * `pdf-text.ts`), so we declare the one symbol we use rather than pulling in `any`.
 *
 * Referenced from `pdf-text.ts` via a triple-slash directive so every compilation
 * that includes that file (the importers package AND the desktop bundle that
 * imports it transitively) loads this declaration — it is not auto-discovered.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  /** The worker-side message handler pdfjs runs on the main thread when registered. */
  export const WorkerMessageHandler: unknown;
}
