import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPdfPages, extractPdfTitle } from "./pdf-text";

const here = path.dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(here, "__fixtures__", name)));
}

describe("pdf-text direct helpers", () => {
  it("extractPdfTitle returns null for PDFs without a document title", async () => {
    await expect(extractPdfTitle(readFixture("two-page-text.pdf"))).resolves.toBeNull();
  });

  it("extractPdfPages copies input bytes before pdfjs can consume them", async () => {
    const bytes = readFixture("heading-body.pdf");
    const before = Array.from(bytes.slice(0, 8));

    const pages = await extractPdfPages(bytes);

    expect(pages).toHaveLength(1);
    expect(Array.from(bytes.slice(0, 8))).toEqual(before);
  });
});
