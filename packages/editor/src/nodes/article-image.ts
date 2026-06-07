/**
 * Constrained article-image node (U1).
 *
 * URL-imported article images are stored in the local asset vault and rendered
 * through a narrow custom protocol. The document node therefore stores only a
 * protocol URL plus descriptive attrs: no raw filesystem paths, no remote URLs,
 * no srcset, no styles, and no event handlers. The sanitizer/importer are the
 * primary security boundary; this node adds a second render-time guard so a
 * malformed stored JSON node cannot hotlink a remote image.
 */

import { mergeAttributes, Node } from "@tiptap/core";

export const ARTICLE_IMAGE_NODE_NAME = "image" as const;
export const ARTICLE_IMAGE_PROTOCOL = "article-image" as const;
export const ARTICLE_IMAGE_SRC_PREFIX = `${ARTICLE_IMAGE_PROTOCOL}://` as const;

const ARTICLE_IMAGE_ID = "[A-Za-z0-9_-]+";
const ARTICLE_IMAGE_SRC_RE = new RegExp(
  `^${ARTICLE_IMAGE_SRC_PREFIX}${ARTICLE_IMAGE_ID}/${ARTICLE_IMAGE_ID}$`,
);
const MAX_TEXT_ATTR_LENGTH = 500;
const MAX_IMAGE_DIMENSION = 20_000;

export interface ArticleImageAttrs {
  readonly src: string;
  readonly alt?: string | null;
  readonly title?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
}

export function normalizeArticleImageSrc(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const src = value.trim();
  return ARTICLE_IMAGE_SRC_RE.test(src) ? src : null;
}

export function isArticleImageSrc(value: unknown): value is string {
  return normalizeArticleImageSrc(value) !== null;
}

function replaceControlCharacters(value: string): string {
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : char;
  }).join("");
}

export function normalizeArticleImageTextAttr(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = replaceControlCharacters(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_ATTR_LENGTH);
  return text.length > 0 ? text : null;
}

export function normalizeArticleImageDimension(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = typeof value === "number" ? String(value) : value.trim();
  if (!/^[1-9]\d{0,4}$/.test(raw)) return null;
  const dimension = Number.parseInt(raw, 10);
  return dimension <= MAX_IMAGE_DIMENSION ? dimension : null;
}

function readAttrs(element: HTMLElement): ArticleImageAttrs | false {
  const src = normalizeArticleImageSrc(element.getAttribute("src"));
  if (!src) return false;
  return {
    src,
    alt: normalizeArticleImageTextAttr(element.getAttribute("alt")),
    title: normalizeArticleImageTextAttr(element.getAttribute("title")),
    width: normalizeArticleImageDimension(element.getAttribute("width")),
    height: normalizeArticleImageDimension(element.getAttribute("height")),
  };
}

function renderDimension(value: unknown): string | undefined {
  const dimension = normalizeArticleImageDimension(value);
  return dimension === null ? undefined : String(dimension);
}

/**
 * A block atom for a locally-owned article image. It is selectable but not
 * draggable, so it behaves like a document object without enabling arbitrary
 * drag/drop image insertion.
 */
export const ArticleImage = Node.create({
  name: ARTICLE_IMAGE_NODE_NAME,

  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      src: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          normalizeArticleImageSrc(element.getAttribute("src")) ?? "",
        renderHTML: () => ({}),
      },
      alt: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          normalizeArticleImageTextAttr(element.getAttribute("alt")),
        renderHTML: () => ({}),
      },
      title: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          normalizeArticleImageTextAttr(element.getAttribute("title")),
        renderHTML: () => ({}),
      },
      width: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          normalizeArticleImageDimension(element.getAttribute("width")),
        renderHTML: () => ({}),
      },
      height: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          normalizeArticleImageDimension(element.getAttribute("height")),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "img[src]",
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false;
          return readAttrs(node);
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    const src = normalizeArticleImageSrc(node.attrs.src);
    const alt = normalizeArticleImageTextAttr(node.attrs.alt) ?? "";
    const title = normalizeArticleImageTextAttr(node.attrs.title);
    const width = renderDimension(node.attrs.width);
    const height = renderDimension(node.attrs.height);

    if (!src) {
      return [
        "span",
        mergeAttributes(HTMLAttributes, {
          "data-article-image-invalid": "true",
          role: "note",
        }),
        alt,
      ];
    }

    return [
      "img",
      mergeAttributes(HTMLAttributes, {
        src,
        alt,
        ...(title ? { title } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      }),
    ];
  },
});
