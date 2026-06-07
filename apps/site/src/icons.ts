import {
  Bookmark,
  Brackets,
  Brain,
  ChevronRight,
  Command,
  Download,
  FileText,
  Gauge,
  Globe,
  Highlighter,
  Layers,
  Library,
  type LucideIcon,
  Quote,
  ShieldCheck,
  SquareStack,
  Target,
} from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ICONS = {
  bookmark: Bookmark,
  brain: Brain,
  card: SquareStack,
  chevronRight: ChevronRight,
  cloze: Brackets,
  command: Command,
  download: Download,
  extract: Quote,
  gauge: Gauge,
  globe: Globe,
  highlight: Highlighter,
  layers: Layers,
  library: Library,
  shield: ShieldCheck,
  source: FileText,
  target: Target,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export const iconNames = Object.keys(ICONS) as IconName[];

export function isIconName(name: string): name is IconName {
  return Object.hasOwn(ICONS, name);
}

function normalizeSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) {
    return 16;
  }

  return Math.round(size);
}

export function iconSvg(name: string, size = 16): string {
  const normalizedSize = normalizeSize(size);

  if (!isIconName(name)) {
    return `<svg width="${normalizedSize}" height="${normalizedSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"></svg>`;
  }

  return renderToStaticMarkup(
    createElement(ICONS[name], {
      "aria-hidden": true,
      focusable: false,
      size: normalizedSize,
      strokeWidth: 1.75,
    }),
  );
}
