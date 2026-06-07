import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ExtensionManifest {
  readonly action?: { readonly default_popup?: string };
  readonly commands?: unknown;
  readonly options_page?: string;
  readonly side_panel?: { readonly default_path?: string };
}

function readManifest(): ExtensionManifest {
  return JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
}

describe("extension manifest", () => {
  it("keeps the popup and options surfaces without registering keyboard commands", () => {
    const manifest = readManifest();

    expect(manifest.commands).toBeUndefined();
    expect(manifest.action?.default_popup).toBe("popup.html");
    expect(manifest.options_page).toBe("options.html");
    expect(manifest.side_panel?.default_path).toBe("sidepanel.html");
  });
});
