/**
 * Desktop dev launcher (T007) — `pnpm --filter @interleave/desktop dev`, which
 * the root `pnpm dev` ultimately drives in desktop mode.
 *
 * 1. starts the Vite renderer dev server (apps/web) and waits for it,
 * 2. builds the main + preload bundle once,
 * 3. launches Electron against the dev server URL with hot-reloaded renderer.
 *
 * Kept dependency-light: no concurrently/wait-on, just child processes + a small
 * readiness poll. Ctrl-C tears everything down.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";
const children = [];

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: "inherit", shell: false, ...opts });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Renderer dev server did not start at ${url}`);
}

async function main() {
  // 1) Renderer dev server.
  run("pnpm", ["--filter", "@interleave/web", "dev"], { cwd: repoRoot });
  await waitForServer(DEV_SERVER_URL);

  // 2) Build main + preload (one-shot; restart `pnpm dev` to rebundle).
  await new Promise((resolve, reject) => {
    const build = run("node", ["build.mjs"], { cwd: desktopDir });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("bundle failed"))));
  });

  // 3) Electron against the dev server.
  const electron = run("electron", ["."], {
    cwd: desktopDir,
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV_SERVER_URL },
  });
  electron.on("exit", (code) => shutdown(code ?? 0));
}

main().catch((error) => {
  console.error(error);
  shutdown(1);
});
