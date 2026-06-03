/**
 * Help center information architecture (design handoff — "Incremental Reading.html").
 *
 * The CONTRACT: kebab-case `slug`s are frozen; in-app deep links reference slugs,
 * never titles, so titles can be edited freely. This module owns the IA (categories
 * + articles), the popular/pillar set, the search alias map, the glossary, the
 * "related articles" graph, the flat `bySlug` lookup, and the search ranking.
 *
 * Article PROSE lives in `help-bodies.ts` (authored separately). Audience: N(ew),
 * I(ntermediate), A(dvanced). Status: shipped · partial · planned.
 */

export type Audience = "N" | "I" | "A";
export type Status = "shipped" | "partial" | "planned";

/** A help-center article body block (rendered by `HelpCenter`). */
export type HelpBlock =
  | { type: "p"; text: string }
  | { type: "h2"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "callout"; icon?: string; text: string }
  | { type: "figure"; figure: "pipeline" | "schedulers" | "extract-vs-hl" };

/** Article tuple inside a category: [slug, title, audience, status, screenToken?]. */
type ArtTuple = readonly [string, string, Audience, Status, string?];

interface Category {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly blurb: string;
  readonly arts: readonly ArtTuple[];
}

export interface ArticleMeta {
  readonly slug: string;
  readonly title: string;
  readonly audience: Audience;
  readonly status: Status;
  /** A real renderer route the "Open the relevant screen" button navigates to. */
  readonly screen?: string;
  readonly cat?: string;
  readonly catTitle?: string;
  readonly special?: boolean;
}

/** Map the design's screen tokens to real renderer routes. Tokens that need an
 *  element id (reader/builder/synthesis) resolve to `undefined` — no generic
 *  deep-link, so the article hides its "Open the relevant screen" button. */
const SCREEN_ROUTE: Record<string, string> = {
  home: "/",
  queue: "/queue",
  inbox: "/inbox",
  review: "/review",
  library: "/library",
  search: "/search",
  concepts: "/concepts",
  analytics: "/analytics",
  settings: "/settings",
  trash: "/trash",
};

export const HELP_CATEGORIES: readonly Category[] = [
  {
    id: "start",
    title: "Getting Started",
    icon: "play",
    blurb: "What the app is, your first 15 minutes, and the shape of the daily loop.",
    arts: [
      ["welcome", "Welcome: what it is and isn’t", "N", "shipped"],
      ["first-15-minutes", "Your first 15 minutes", "N", "shipped"],
      ["home-dashboard", "The Home command center: what each number means", "N", "shipped", "home"],
      [
        "start-session-vs-queue-vs-review",
        "Start session vs Open queue vs Review",
        "N",
        "shipped",
        "queue",
      ],
      ["app-shell", "The app shell: sidebar, inspector, badges, status bar", "N", "shipped"],
    ],
  },
  {
    id: "method",
    title: "The Method",
    icon: "layers",
    blurb: "Incremental reading itself — the refinery, the two schedulers, why overload is fine.",
    arts: [
      ["what-is-incremental-reading", "What is incremental reading?", "N", "shipped"],
      ["extracts-vs-highlights", "Extracts vs highlights: the core difference", "N", "shipped"],
      ["two-schedulers", "The two schedulers: cards (FSRS) vs attention", "N", "shipped"],
      [
        "overload-is-a-feature",
        "Overload is a feature: import more than you can finish",
        "N",
        "shipped",
        "queue",
      ],
      ["priority-abcd", "Priority A/B/C/D and protecting what matters", "N", "shipped"],
      ["lineage", "Lineage: every card knows where it came from", "I", "shipped"],
      ["daily-rhythm-70-20-10", "Your daily rhythm and the 70/20/10 mix", "I", "shipped"],
      ["what-to-import", "What to import (and what not to)", "N", "shipped", "inbox"],
    ],
  },
  {
    id: "import",
    title: "Importing & Inbox Triage",
    icon: "inbox",
    blurb: "Every way material gets in, and how to triage the inbox like a decision gate.",
    arts: [
      ["import-overview", "Getting material in: every way to import", "N", "shipped", "inbox"],
      [
        "inbox-triage",
        "Triage your inbox: Activate, Save for later, Delete",
        "N",
        "shipped",
        "inbox",
      ],
      ["import-web", "Import from the web (URL & YouTube)", "I", "shipped", "inbox"],
      ["import-documents", "Import books, documents, and notes", "I", "shipped", "inbox"],
      [
        "migrating-readwise-kindle-anki",
        "Migrating from Readwise, Kindle, and Anki",
        "I",
        "shipped",
        "inbox",
      ],
    ],
  },
  {
    id: "reading",
    title: "Reading & Extracting",
    icon: "source",
    blurb: "The Source Reader, read-points, the extract gesture, and distillation.",
    arts: [
      ["source-reader", "How the Source Reader works", "N", "shipped", "reader"],
      ["read-points", "Read-points: bookmarking where you stopped", "N", "shipped", "reader"],
      ["extracting", "Extracting a passage into its own item", "N", "shipped", "reader"],
      [
        "highlights-and-processed",
        "Highlights and mark-processed: reading aids",
        "N",
        "shipped",
        "reader",
      ],
      [
        "distilling-extracts",
        "Distilling extracts into atomic statements",
        "I",
        "shipped",
        "builder",
      ],
      ["extract-workspace", "The distillation workspace", "I", "shipped", "builder"],
      ["sub-extracts", "Sub-extracts: splitting while keeping lineage", "I", "shipped", "builder"],
      ["reading-pdfs", "Reading PDFs: pages, region figures, and OCR", "I", "shipped", "reader"],
      ["reading-media", "Reading video & audio: transcripts and clips", "I", "shipped", "reader"],
      [
        "pruning-sources",
        "Deleting, postponing, and pruning sources safely",
        "N",
        "shipped",
        "reader",
      ],
    ],
  },
  {
    id: "cards",
    title: "Cards & Review",
    icon: "card",
    blurb: "Turning extracts into cards, writing good ones, and the active-recall session.",
    arts: [
      ["extract-to-card", "Turning an extract into a flashcard", "N", "shipped", "builder"],
      [
        "good-cards",
        "Writing good cards: the minimum information principle",
        "N",
        "shipped",
        "builder",
      ],
      [
        "quality-checks",
        "Understanding the Quality checks (ok / warn / block)",
        "N",
        "shipped",
        "builder",
      ],
      ["cloze-cards", "Cloze deletion cards", "N", "shipped", "builder"],
      ["image-occlusion", "Image occlusion cards", "I", "shipped", "builder"],
      ["formula-code-cards", "Formula and code cards", "I", "shipped", "builder"],
      ["siblings-and-priority", "Sibling cards and priority", "I", "shipped"],
      ["audio-cards", "Audio review cards", "A", "shipped"],
      [
        "review-session",
        "Reviewing flashcards: the active-recall session",
        "N",
        "shipped",
        "review",
      ],
      ["grading-honestly", "How to grade honestly (and why it matters)", "N", "shipped", "review"],
      [
        "no-cards-due",
        "Why some cards aren’t due / “No cards due” explained",
        "N",
        "shipped",
        "review",
      ],
      ["repair-cards", "Fixing or removing a bad card during review", "I", "shipped", "review"],
      [
        "desired-retention",
        "Desired retention and your daily review load",
        "I",
        "shipped",
        "settings",
      ],
      ["leeches", "Leeches: handling cards you keep failing", "I", "shipped", "review"],
      ["review-modes", "Targeted review modes", "A", "shipped", "review"],
      ["card-lifetimes", "Card lifetimes and verification tasks", "A", "shipped"],
    ],
  },
  {
    id: "sched",
    title: "Scheduling, Priority & Overload",
    icon: "gauge",
    blurb: "The daily loop, the review budget, auto-postpone, catch-up and vacation.",
    arts: [
      ["daily-loop", "The daily loop: queue, process session, and review", "N", "shipped", "queue"],
      ["process-session", "Running a Process session (keyboard-first)", "N", "shipped", "queue"],
      [
        "review-budget",
        "The daily review budget and over-budget overload",
        "I",
        "shipped",
        "settings",
      ],
      ["auto-postpone", "Auto-postpone: relieving an over-budget day", "I", "shipped", "queue"],
      [
        "catch-up-vacation",
        "Catch-up and Vacation: recovering from backlog",
        "I",
        "shipped",
        "queue",
      ],
      ["fragile-vs-mature", "Fragile vs mature cards (and why some get postponed)", "A", "shipped"],
      ["postpone-vs-schedule", "Postpone vs Schedule", "I", "shipped", "queue"],
      [
        "queue-filters-ordering",
        "Filters, the protected accent bar, and queue ordering",
        "I",
        "shipped",
        "queue",
      ],
      ["workload-simulator", "Simulating workload before a big change", "A", "shipped", "settings"],
    ],
  },
  {
    id: "organize",
    title: "Organizing & Finding",
    icon: "concepts",
    blurb: "Search vs Library, concepts vs tags, the knowledge map, retention targets.",
    arts: [
      ["search-vs-library", "Finding things: Search vs Library", "N", "shipped", "library"],
      ["keyword-search", "Using keyword search", "N", "shipped", "search"],
      ["library-browse", "Browsing your whole collection (Library)", "N", "shipped", "library"],
      ["concepts-vs-tags", "Concepts vs tags: how to organize", "N", "shipped", "concepts"],
      ["creating-concepts", "Creating and assigning concepts", "N", "shipped", "concepts"],
      ["concept-map", "The concept knowledge map", "I", "shipped", "concepts"],
      [
        "concept-retention",
        "Per-concept review targets (desired retention)",
        "A",
        "shipped",
        "concepts",
      ],
      ["facet-counts", "How facet counts work (drill-down)", "I", "shipped", "library"],
    ],
  },
  {
    id: "maint",
    title: "Maintenance & Safety",
    icon: "shield",
    blurb: "Nothing is lost: delete, Trash, undo, leeches, stagnant extracts, integrity.",
    arts: [
      ["nothing-is-lost", "Nothing is lost: delete, Trash, and Undo", "N", "shipped", "trash"],
      ["using-trash", "Using Trash: restore, purge, and empty", "N", "shipped", "trash"],
      [
        "maintenance-hub",
        "The Maintenance hub: keeping a large collection healthy",
        "I",
        "shipped",
      ],
      ["fixing-leeches", "Fixing leeches: cards you keep getting wrong", "I", "shipped"],
      ["stagnant-vs-leech", "Stagnant extracts vs leeches: two kinds of “stuck”", "I", "shipped"],
      ["retiring-cards", "Retiring cards: parking knowledge without losing it", "I", "shipped"],
      ["integrity-check", "Reading the integrity check", "A", "shipped"],
      ["pruning-library", "Pruning an overloaded library safely", "I", "shipped"],
    ],
  },
  {
    id: "data",
    title: "Data, Backup & Settings",
    icon: "download",
    blurb: "Where your data lives, backups vs exports, and what every setting does.",
    arts: [
      [
        "where-your-data-lives",
        "Where your data lives (local-first, no cloud)",
        "N",
        "shipped",
        "settings",
      ],
      ["backing-up", "Backing up your vault", "N", "shipped", "settings"],
      ["backup-vs-export", "Backup vs Export — which do I need?", "N", "shipped", "settings"],
      ["exporting", "Exporting to Anki and Markdown", "I", "shipped"],
      [
        "review-scheduling-settings",
        "Review & scheduling settings explained",
        "N",
        "shipped",
        "settings",
      ],
      [
        "per-priority-retention",
        "Protecting high-value memory with per-priority retention",
        "I",
        "shipped",
        "settings",
      ],
      [
        "interface-settings",
        "Interface settings: theme, display name, keyboard layout",
        "N",
        "partial",
        "settings",
      ],
      ["undo-redo", "Undo, redo, and not losing your work", "N", "partial"],
      ["theming", "Light & dark theme and how theming works", "A", "shipped"],
      ["server-backup-sync", "Encrypted server backup & sync", "A", "planned"],
    ],
  },
  {
    id: "advanced",
    title: "Advanced",
    icon: "sparkle",
    blurb: "Synthesis notes, AI assistance & semantic search, the browser extension.",
    arts: [
      [
        "synthesis-notes-intro",
        "What is a synthesis note? (Incremental writing)",
        "I",
        "shipped",
        "synthesis",
      ],
      ["synthesis-create", "Create and write a synthesis note", "N", "shipped", "synthesis"],
      ["synthesis-collect", "Collect extracts and cards into a note", "I", "shipped", "synthesis"],
      ["synthesis-schedule", "Scheduling a synthesis note to return", "I", "shipped", "synthesis"],
      [
        "ai-assistance",
        "AI assistance: draft cards, never schedule them",
        "N",
        "partial",
        "builder",
      ],
      ["ai-setup", "Setting up AI: providers and your own API key", "N", "partial", "settings"],
      [
        "ai-trust-model",
        "Your data and AI: the local-first trust model",
        "N",
        "shipped",
        "settings",
      ],
      ["semantic-search", "On-device semantic search", "I", "partial", "search"],
      [
        "related-duplicates-conflicts",
        "Related items, possible duplicates, and conflicts",
        "I",
        "shipped",
      ],
      ["ai-grounding", "How AI suggestions stay grounded to your sources", "A", "shipped"],
      ["extension-install", "Install the browser extension", "N", "shipped", "settings"],
      ["extension-pairing", "Pair the extension with the desktop app", "N", "shipped", "settings"],
      ["extension-capture", "Capture pages and selections", "N", "shipped"],
      ["extension-troubleshooting", "Troubleshooting capture (it’s not saving)", "I", "shipped"],
      ["extension-privacy", "How browser capture works and stays private", "I", "shipped"],
      ["extension-tokens", "Manage and re-pair: tokens, regenerate, unpairing", "A", "shipped"],
    ],
  },
];

/** Reference pages rendered with custom views (not the article template). */
export const HELP_SPECIAL: readonly ArticleMeta[] = [
  {
    slug: "keyboard-reference",
    title: "Keyboard Reference",
    audience: "N",
    status: "shipped",
    special: true,
  },
  { slug: "glossary", title: "Concepts Glossary", audience: "N", status: "shipped", special: true },
];

/** Pillar articles surfaced first on the help home. */
export const HELP_POPULAR: readonly string[] = [
  "what-is-incremental-reading",
  "extracts-vs-highlights",
  "two-schedulers",
  "overload-is-a-feature",
];

/** Words users actually type → the slug that answers them. */
const SYNONYMS: Record<string, string> = {
  "highlight not working": "extracts-vs-highlights",
  "highlight vs extract": "extracts-vs-highlights",
  "import readwise": "migrating-readwise-kindle-anki",
  kindle: "migrating-readwise-kindle-anki",
  anki: "migrating-readwise-kindle-anki",
  "too many cards": "review-budget",
  "over budget": "review-budget",
  overload: "overload-is-a-feature",
  "restore backup": "backing-up",
  "restore deleted": "using-trash",
  restore: "using-trash",
  "g key not working": "keyboard-reference",
  shortcuts: "keyboard-reference",
  "dark mode": "interface-settings",
  "two clocks": "two-schedulers",
  "recall percent": "two-schedulers",
  "no cards due": "no-cards-due",
  undo: "undo-redo",
  redo: "undo-redo",
};

/** [term, definition, slug] — the concepts glossary. */
export const HELP_GLOSSARY: readonly [string, string, string][] = [
  [
    "Element",
    "The universal primitive — every source, topic, extract, card, task, concept, and synthesis note is an element.",
    "welcome",
  ],
  [
    "Source",
    "An imported text/PDF/media you read incrementally; the root of a lineage chain.",
    "source-reader",
  ],
  [
    "Topic",
    "A scheduled unit of reading on the attention scheduler (created by a media clip, a cropped PDF region, or an EPUB chapter).",
    "two-schedulers",
  ],
  [
    "Extract",
    "A passage lifted out of a source into its own independently-scheduled element — not a highlight.",
    "extracts-vs-highlights",
  ],
  [
    "Sub-extract",
    "An extract made from inside another extract; its parent is that extract, its source stays the original.",
    "sub-extracts",
  ],
  [
    "Highlight",
    "An in-document annotation only; no element, no schedule, no lineage. Click to remove.",
    "highlights-and-processed",
  ],
  [
    "Atomic statement",
    "The distillation stage meaning “one self-contained idea, card-ready” (not yet a card).",
    "distilling-extracts",
  ],
  [
    "Card",
    "A flashcard scheduled by FSRS; created from an extract and inheriting its lineage; starts as a draft.",
    "extract-to-card",
  ],
  [
    "Cloze",
    "A card type where you wrap the answer in {{ }} so it shows as a fill-in blank.",
    "cloze-cards",
  ],
  [
    "Read-point",
    "The single resume bookmark per source (set with Space); auto-advances when you extract.",
    "read-points",
  ],
  [
    "Lineage",
    "The actionable chain card → extract → source location → source → document.",
    "lineage",
  ],
  [
    "FSRS",
    "The spaced-repetition algorithm that schedules cards by self-graded recall — the brain chip.",
    "two-schedulers",
  ],
  [
    "Attention scheduler",
    "The separate scheduler for sources/extracts/tasks/notes (“process again, when?”) — the gauge chip.",
    "two-schedulers",
  ],
  [
    "Priority A/B/C/D",
    "Value bands; A is protected and returns daily, D is background. New imports default to C.",
    "priority-abcd",
  ],
  [
    "Stage",
    "Where an item sits in the pipeline (raw → clean → atomic → card …); separate from status.",
    "distilling-extracts",
  ],
  [
    "Mature card",
    "A card whose FSRS stability passed ~21 days; only mature low-priority cards are sacrificed under overload.",
    "fragile-vs-mature",
  ],
  ["Leech", "A card auto-flagged at 4+ lapses; routed to the leech remediation view.", "leeches"],
  [
    "Stagnant extract",
    "An extract that keeps returning without progressing (postponed repeatedly, never advanced).",
    "stagnant-vs-leech",
  ],
  [
    "Retire",
    "Parking a low-value mature card out of active review while keeping its history; reversible.",
    "retiring-cards",
  ],
  [
    "Soft delete",
    "Moving an item to Trash — recoverable via Restore or ⌘Z. Not destruction.",
    "nothing-is-lost",
  ],
  [
    "Task / verification task",
    "A scheduled to-do on the attention scheduler; a verification task re-checks a possibly-outdated card and opens the element it protects.",
    "card-lifetimes",
  ],
  [
    "Synthesis note",
    "Your own long-lived writing woven from referenced extracts/cards; scheduled on attention, never reviewed.",
    "synthesis-notes-intro",
  ],
  [
    "Concept",
    "A hierarchical, filterable, mappable organizing bucket that can carry a review target.",
    "concepts-vs-tags",
  ],
  ["Tag", "A flat label, matchable by keyword search only (no filter facet).", "concepts-vs-tags"],
  [
    "Daily review budget",
    "A soft cap (default 60/day) that turns on the overload tools; not a hard limit.",
    "review-budget",
  ],
  [
    "Desired retention",
    "The FSRS target recall probability (default 90%) that tunes how often cards return.",
    "desired-retention",
  ],
  [
    "Local vault",
    "Your single on-device database + asset vault; there is no account and no cloud copy.",
    "where-your-data-lives",
  ],
];

/** Hand-curated related links (fallback: siblings in the same category). */
const RELATED: Record<string, string[]> = {
  "extracts-vs-highlights": [
    "read-points",
    "distilling-extracts",
    "extract-to-card",
    "two-schedulers",
  ],
  "two-schedulers": ["overload-is-a-feature", "review-session", "priority-abcd", "review-budget"],
  "overload-is-a-feature": ["review-budget", "auto-postpone", "priority-abcd", "nothing-is-lost"],
  "what-is-incremental-reading": [
    "extracts-vs-highlights",
    "two-schedulers",
    "overload-is-a-feature",
    "first-15-minutes",
  ],
};

/** Flat slug → meta lookup (categories then specials). */
export const HELP_BY_SLUG: Record<string, ArticleMeta> = {};
for (const c of HELP_CATEGORIES) {
  for (const a of c.arts) {
    const screen = a[4] ? SCREEN_ROUTE[a[4]] : undefined;
    HELP_BY_SLUG[a[0]] = {
      slug: a[0],
      title: a[1],
      audience: a[2],
      status: a[3],
      ...(screen ? { screen } : {}),
      cat: c.id,
      catTitle: c.title,
    };
  }
}
for (const s of HELP_SPECIAL) {
  HELP_BY_SLUG[s.slug] = { ...s };
}

export function relatedSlugs(slug: string): string[] {
  if (RELATED[slug]) return RELATED[slug];
  const meta = HELP_BY_SLUG[slug];
  if (!meta?.cat) return [];
  const cat = HELP_CATEGORIES.find((c) => c.id === meta.cat);
  if (!cat) return [];
  return cat.arts
    .map((a) => a[0])
    .filter((s) => s !== slug)
    .slice(0, 4);
}

/** Rank articles for a query: synonyms, then title/slug/category/glossary hits. */
export function searchHelp(query: string): ArticleMeta[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  const hits = new Map<string, number>();
  const bump = (slug: string, score: number) => {
    if (HELP_BY_SLUG[slug]) hits.set(slug, Math.max(hits.get(slug) || 0, score));
  };
  const exact = SYNONYMS[q];
  if (exact) bump(exact, 100);
  for (const [k, target] of Object.entries(SYNONYMS)) {
    if (k.includes(q) || q.includes(k)) bump(target, 60);
  }
  for (const a of Object.values(HELP_BY_SLUG)) {
    const t = a.title.toLowerCase();
    const s = a.slug.toLowerCase();
    let score = 0;
    if (t.includes(q)) score += 40;
    if (s.includes(q)) score += 20;
    if (a.catTitle?.toLowerCase().includes(q)) score += 8;
    if (score) bump(a.slug, score);
  }
  for (const g of HELP_GLOSSARY) {
    if (g[0].toLowerCase().includes(q)) bump(g[2], 30);
  }
  return [...hits.entries()]
    .sort((a, b) => b[1] - a[1])
    .map((e) => HELP_BY_SLUG[e[0]])
    .filter((a): a is ArticleMeta => Boolean(a))
    .slice(0, 12);
}
