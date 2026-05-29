/**
 * Custom `app://` protocol for the built renderer (T007).
 *
 * Loading the production renderer over `file://` breaks two things: Vite's
 * absolute asset URLs (`/assets/…`) resolve against the filesystem root, and the
 * router sees a `…/index.html` pathname instead of `/`. Serving the built files
 * over a registered `app://` scheme fixes both: assets resolve correctly and the
 * SPA loads at pathname `/`, so TanStack Router matches the home route. Unknown
 * routes fall back to `index.html` (SPA history routing).
 *
 * The scheme is registered as `standard` + `secure` so `fetch`, history routing,
 * and a normal web-security posture all work. Files are served read-only from the
 * renderer dist directory, with path-traversal rejected.
 */

import fs from "node:fs";
import path from "node:path";
import { net, protocol } from "electron";

/** The scheme + host used to load the renderer, e.g. `app://bundle/`. */
export const RENDERER_SCHEME = "app";
const RENDERER_HOST = "bundle";

/** The renderer's entry URL. */
export const RENDERER_URL = `${RENDERER_SCHEME}://${RENDERER_HOST}/`;

/**
 * Register the scheme as privileged. MUST be called before `app.whenReady()`
 * (Electron requirement for standard/secure schemes).
 */
export function registerRendererSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** Install the `app://` handler that serves files from `rendererDir`. */
export function registerRendererProtocol(rendererDir: string): void {
  protocol.handle(RENDERER_SCHEME, (request) => {
    const url = new URL(request.url);
    // Strip the leading slash; default to index.html for the SPA root.
    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (relative === "") relative = "index.html";

    const resolved = path.join(rendererDir, relative);
    const normalizedRoot = path.resolve(rendererDir);
    const normalizedTarget = path.resolve(resolved);

    // Reject path traversal outside the renderer dir.
    if (
      !normalizedTarget.startsWith(normalizedRoot + path.sep) &&
      normalizedTarget !== normalizedRoot
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    // SPA fallback: a non-file path (a client route) serves index.html.
    const target =
      fs.existsSync(normalizedTarget) && fs.statSync(normalizedTarget).isFile()
        ? normalizedTarget
        : path.join(rendererDir, "index.html");

    return net.fetch(`file://${target}`);
  });
}
