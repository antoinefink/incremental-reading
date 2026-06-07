import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import config from "./vite.config";

const require = createRequire(import.meta.url);

describe("site Vite config", () => {
  it("serves the static site on fixed localhost-only dev endpoints", () => {
    expect(config.server?.host).toBe("127.0.0.1");
    expect(config.server?.port).toBe(5174);
    expect(config.server?.strictPort).toBe(true);
    expect(config.preview?.host).toBe("127.0.0.1");
    expect(config.preview?.port).toBe(4174);
    expect(config.preview?.strictPort).toBe(true);
  });

  it("allows only the site app and shared design assets", () => {
    const allow = config.server?.fs?.allow ?? [];

    expect(allow).toEqual([
      import.meta.dirname,
      resolve(import.meta.dirname, "../../design"),
      dirname(require.resolve("@fontsource/ibm-plex-sans/package.json")),
      dirname(require.resolve("@fontsource/ibm-plex-serif/package.json")),
      dirname(require.resolve("@fontsource/ibm-plex-mono/package.json")),
    ]);
    expect(allow).not.toContain(resolve(import.meta.dirname, "../.."));
  });
});
