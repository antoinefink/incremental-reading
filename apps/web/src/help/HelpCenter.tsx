/**
 * Help Center (design handoff — "Incremental Reading.html").
 *
 * An in-app overlay surface (NOT a website — the app is offline-first): a search +
 * category home, an article rail + reading pane, the concepts glossary, and a
 * keyboard reference DERIVED from the single shortcut registry (`shortcuts.ts`)
 * so the docs can never drift from the real handlers. Every in-app help hook
 * deep-links here by slug (the frozen contract in `help-data.ts`).
 *
 * Presentation-only: article prose is authored data; the only side effect is the
 * optional "Open the relevant screen" navigation, delegated to the caller.
 */
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import { Kbd } from "../shell/Kbd";
import { GOTO_MAP } from "../shell/nav";
import { CHEAT_GROUP_ORDER, SHORTCUTS } from "../shell/shortcuts";
import { HELP_BODIES } from "./help-bodies";
import {
  type ArticleMeta,
  HELP_BY_SLUG,
  HELP_CATEGORIES,
  HELP_GLOSSARY,
  HELP_POPULAR,
  HELP_SPECIAL,
  relatedSlugs,
  type Status,
  searchHelp,
} from "./help-data";
import { Btn, cx, Pipeline } from "./primitives";
import "./help.css";

function StatusTag({ status }: { status?: Status }) {
  if (!status || status === "shipped") return null;
  const map: Record<string, [string, IconName, string]> = {
    partial: ["partial", "hourglass", "Partial"],
    planned: ["planned", "clock", "Planned"],
  };
  const m = map[status];
  if (!m) return null;
  return (
    <span className={`statustag statustag--${m[0]}`}>
      <Icon name={m[1]} size={11} />
      {m[2]}
    </span>
  );
}

/** Inline figures used by flagship article bodies. */
function ArtFigure({ kind }: { kind: string }) {
  if (kind === "pipeline") {
    return (
      <div className="hc-callout" style={{ display: "block", background: "var(--surface-2)" }}>
        <Pipeline active={null} />
      </div>
    );
  }
  if (kind === "schedulers") {
    return (
      <div className="hc-figure">
        <div className="coach__demo-card">
          <b style={{ color: "var(--sched-fsrs)" }}>
            <Icon name="brain" size={14} /> Cards · FSRS
          </b>
          <span>
            “Can you recall this?” — carries a recall % and grade buttons. The brain chip.
          </span>
        </div>
        <div className="coach__demo-card">
          <b style={{ color: "var(--sched-attn)" }}>
            <Icon name="gauge" size={14} /> Sources &amp; extracts
          </b>
          <span>
            “Should you process this again, when?” — a stage and a return date. The gauge chip.
          </span>
        </div>
      </div>
    );
  }
  if (kind === "extract-vs-hl") {
    return (
      <div className="hc-figure">
        <div className="coach__demo-card">
          <b style={{ color: "var(--el-extract)" }}>
            <Icon name="extract" size={14} /> Extract <Kbd keys="E" />
          </b>
          <span>A new scheduled item with lineage — it comes back to you.</span>
        </div>
        <div className="coach__demo-card">
          <b style={{ color: "oklch(0.62 0.13 95)" }}>
            <Icon name="highlight" size={14} /> Highlight <Kbd keys="H" />
          </b>
          <span>Just a mark in the source. No item, no schedule.</span>
        </div>
      </div>
    );
  }
  return null;
}

function ArticleBody({ slug }: { slug: string }) {
  const blocks = HELP_BODIES[slug];
  if (!blocks) {
    return (
      <div className="hc-stub">
        <span className="hc-stub__ico">
          <Icon name="edit" size={20} />
        </span>
        <span className="hc-stub__t">This article is queued for writing</span>
        <span className="hc-stub__b">
          The information architecture, slug, audience, and shipped/planned status are locked. The
          prose, screenshots, and diagrams will be authored against this template.
        </span>
      </div>
    );
  }
  return (
    <div className="hc-read__body">
      {blocks.map((b, i) => {
        const key = `${slug}-${i}`;
        if (b.type === "h2") return <h2 key={key}>{b.text}</h2>;
        if (b.type === "p")
          // Authored docs content (not user input) — safe to render its inline markup.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted authored help prose
          return <p key={key} dangerouslySetInnerHTML={{ __html: b.text }} />;
        if (b.type === "ul")
          return (
            <ul key={key}>
              {b.items.map((li, j) => (
                // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted authored help prose
                // biome-ignore lint/suspicious/noArrayIndexKey: static authored list
                <li key={j} dangerouslySetInnerHTML={{ __html: li }} />
              ))}
            </ul>
          );
        if (b.type === "callout") {
          const icon = (b.icon === "warn" ? "warning" : b.icon || "info") as IconName;
          return (
            <div className="hc-callout" key={key}>
              <Icon name={icon} size={15} />
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted authored help prose */}
              <span dangerouslySetInnerHTML={{ __html: b.text }} />
            </div>
          );
        }
        if (b.type === "figure") return <ArtFigure key={key} kind={b.figure} />;
        return null;
      })}
    </div>
  );
}

function GlossaryView() {
  return (
    <dl className="hc-gloss">
      {HELP_GLOSSARY.map((g) => (
        <div key={g[0]}>
          <dt>{g[0]}</dt>
          <dd>
            {g[1]}{" "}
            {g[2] && HELP_BY_SLUG[g[2]] && (
              <button type="button" className="help-inline" onClick={() => openHelpHash(g[2])}>
                Read more
                <Icon name="chevronRight" size={12} />
              </button>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Internal hash hop so glossary "Read more" can switch articles without prop drilling. */
function openHelpHash(slug: string) {
  window.dispatchEvent(new CustomEvent("interleave:help-open", { detail: slug }));
}

const GOTO_LABEL: Record<string, string> = {
  "/": "Home",
  "/queue": "Daily Queue",
  "/inbox": "Inbox",
  "/review": "Review",
  "/library": "Library",
  "/concepts": "Concepts",
  "/analytics": "Analytics",
  "/settings": "Settings",
};

function KeyboardView() {
  const groups = CHEAT_GROUP_ORDER.map((group) => ({
    group,
    rows: SHORTCUTS.filter((s) => s.group === group).map(
      (s) => [s.keys, s.label] as [readonly string[], string],
    ),
  })).filter((g) => g.rows.length > 0);

  const gnav: [readonly string[], string][] = Object.entries(GOTO_MAP).map(([letter, route]) => [
    ["g", letter],
    `Go to ${GOTO_LABEL[route] ?? route}`,
  ]);

  return (
    <div className="hc-kb">
      {groups.map((grp) => (
        <div className="hc-kb__grp" key={grp.group}>
          <h3>{grp.group}</h3>
          {grp.rows.map((r) => (
            <div className="hc-kb__row" key={r[1]}>
              <span>{r[1]}</span>
              <Kbd keys={r[0]} />
            </div>
          ))}
        </div>
      ))}
      <div className="hc-kb__grp">
        <h3>Quick navigation (g + letter — a two-key chord, ~700ms window)</h3>
        {gnav.map((r) => (
          <div className="hc-kb__row" key={r[1]}>
            <span>{r[1]}</span>
            <Kbd keys={r[0]} />
          </div>
        ))}
      </div>
      <div className="hc-callout">
        <Icon name="info" size={15} />
        <span>
          The <b>g</b>-prefix is a sequential two-key chord with a ~700ms window — not a held combo.
          The keyboard-layout setting (QWERTY/Dvorak/Vim) does not yet remap these bindings, and
          there is no redo.
        </span>
      </div>
    </div>
  );
}

export function HelpCenter({
  open,
  openSlug,
  onClose,
  onNavScreen,
}: {
  open: boolean;
  openSlug?: string | null;
  onClose: () => void;
  onNavScreen: (route: string) => void;
}) {
  const [slug, setSlug] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    setSlug(openSlug || null);
    setQuery("");
    const id = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(id);
  }, [open, openSlug]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (slug) setSlug(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, slug, onClose]);

  // Glossary "Read more" hops to another article.
  useEffect(() => {
    if (!open) return;
    const onHop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === "string") setSlug(detail);
    };
    window.addEventListener("interleave:help-open", onHop);
    return () => window.removeEventListener("interleave:help-open", onHop);
  }, [open]);

  if (!open) return null;

  const results = query.trim() ? searchHelp(query) : null;
  const art: ArticleMeta | null = slug ? (HELP_BY_SLUG[slug] ?? null) : null;
  const cat = art && !art.special ? HELP_CATEGORIES.find((c) => c.id === art.cat) : null;
  const related = art ? relatedSlugs(slug as string) : [];

  const openArticle = (s: string) => {
    setSlug(s);
    const pane = document.querySelector(".hc-read");
    if (pane) pane.scrollTop = 0;
  };

  return (
    <div
      className="hc-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Help center"
      data-testid="help-center"
    >
      <button
        type="button"
        className="hc-overlay__scrim"
        aria-label="Close help center"
        onClick={onClose}
      />
      <div className="hc">
        <div className="hc__top">
          <div className="hc__brand">
            <span className="hc__brand-ico">
              <Icon name="library" size={15} />
            </span>
            Help center
          </div>
          <div className="hc__search">
            <Icon name="search" size={16} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (e.target.value.trim() && slug) setSlug(null);
              }}
              placeholder="Search the help center…"
              aria-label="Search the help center"
            />
            {query && (
              <button
                type="button"
                className="btn btn--ghost btn--sm btn--icon"
                onClick={() => setQuery("")}
                aria-label="Clear search"
              >
                <Icon name="x" size={13} />
              </button>
            )}
          </div>
          <div className="grow" />
          <Btn variant="ghost" icon="x" onClick={onClose}>
            Close <Kbd keys="Esc" />
          </Btn>
        </div>

        <div className="hc__body">
          {!slug ? (
            <div className="hc__home">
              {results ? (
                <>
                  <div className="hc-sech">
                    {results.length} result{results.length !== 1 ? "s" : ""} for “{query}”
                  </div>
                  {results.length === 0 && (
                    <p className="hc__home-sub">
                      No articles match. Try a concept like “extract”, “budget”, or “backup”.
                    </p>
                  )}
                  <div className="hc-pop">
                    {results.map((r) => (
                      <button
                        type="button"
                        className="hc-pop-row"
                        key={r.slug}
                        onClick={() => openArticle(r.slug)}
                      >
                        <Icon
                          name={r.special ? (r.slug === "glossary" ? "text" : "keyboard") : "card"}
                          size={15}
                        />
                        <span className="grow">
                          <span className="hc-pop-row__t">{r.title}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <h1 className="hc__home-h">How can we help?</h1>
                  <p className="hc__home-sub">
                    Everything the in-app tips link to. Search above, or browse by area. Articles
                    are tagged for shipped vs planned features so you never hunt for a button that
                    doesn’t exist.
                  </p>

                  <div className="hc-sech">Start here</div>
                  <div className="hc-pop">
                    {HELP_POPULAR.map((s) => {
                      const a = HELP_BY_SLUG[s];
                      if (!a) return null;
                      return (
                        <button
                          type="button"
                          className="hc-pop-row"
                          key={s}
                          onClick={() => openArticle(s)}
                        >
                          <Icon name="star" size={15} />
                          <span className="grow">
                            <span className="hc-pop-row__t">{a.title}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="hc-sech">Browse by area</div>
                  <div className="hc-cat-grid">
                    {HELP_CATEGORIES.map((c) => (
                      <button
                        type="button"
                        className="hc-cat"
                        key={c.id}
                        onClick={() => {
                          const first = c.arts[0];
                          if (first) openArticle(first[0]);
                        }}
                      >
                        <div className="hc-cat__top">
                          <span className="hc-cat__ico">
                            <Icon name={c.icon as IconName} size={15} />
                          </span>
                          <span className="hc-cat__title">{c.title}</span>
                          <span className="hc-cat__n">{c.arts.length}</span>
                        </div>
                        <span className="hc-cat__blurb">{c.blurb}</span>
                      </button>
                    ))}
                  </div>

                  <div className="hc-sech">Reference</div>
                  <div className="hc-quick">
                    <Btn icon="keyboard" onClick={() => openArticle("keyboard-reference")}>
                      Keyboard reference
                    </Btn>
                    <Btn icon="text" onClick={() => openArticle("glossary")}>
                      Concepts glossary
                    </Btn>
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="hc-rail">
                <button type="button" className="hc-rail__back" onClick={() => setSlug(null)}>
                  <Icon name="chevronLeft" size={14} /> All topics
                </button>
                {results ? (
                  <>
                    <div className="hc-rail__cat">
                      <Icon name="search" size={14} /> Results
                    </div>
                    {results.map((r) => (
                      <button
                        type="button"
                        key={r.slug}
                        className={cx("hc-art", r.slug === slug && "hc-art--on")}
                        onClick={() => openArticle(r.slug)}
                      >
                        <span className="hc-art__dot" />
                        {r.title}
                      </button>
                    ))}
                  </>
                ) : cat ? (
                  <>
                    <div className="hc-rail__cat">
                      <Icon name={cat.icon as IconName} size={14} /> {cat.title}
                    </div>
                    {cat.arts.map((a) => (
                      <button
                        type="button"
                        key={a[0]}
                        className={cx("hc-art", a[0] === slug && "hc-art--on")}
                        onClick={() => openArticle(a[0])}
                      >
                        <span className="hc-art__dot" />
                        {a[1]}
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="hc-rail__cat">
                      <Icon name="text" size={14} /> Reference
                    </div>
                    {HELP_SPECIAL.map((s) => (
                      <button
                        type="button"
                        key={s.slug}
                        className={cx("hc-art", s.slug === slug && "hc-art--on")}
                        onClick={() => openArticle(s.slug)}
                      >
                        <span className="hc-art__dot" />
                        {s.title}
                      </button>
                    ))}
                  </>
                )}
              </div>

              <div className="hc-read">
                <div className="hc-read__inner">
                  <div className="hc-read__crumbs">
                    <button type="button" className="hc-read__crumb" onClick={() => setSlug(null)}>
                      Help
                    </button>
                    <Icon name="chevronRight" size={12} />
                    <span>{art?.special ? "Reference" : art?.catTitle}</span>
                  </div>
                  <div className="hc-read__badges">
                    {art && <StatusTag status={art.status} />}
                    <span className="hc-read__slug">help://{art?.slug}</span>
                  </div>
                  <h1>{art?.title}</h1>

                  {art?.screen && (
                    <div className="hc-screen-link">
                      <Btn
                        variant="soft"
                        icon="external"
                        onClick={() => {
                          onNavScreen(art.screen as string);
                          onClose();
                        }}
                      >
                        Open the relevant screen
                      </Btn>
                    </div>
                  )}

                  {art?.slug === "glossary" ? (
                    <GlossaryView />
                  ) : art?.slug === "keyboard-reference" ? (
                    <KeyboardView />
                  ) : (
                    art && <ArticleBody slug={art.slug} />
                  )}

                  {art && !art.special && related.length > 0 && (
                    <div className="hc-foot">
                      <div className="hc-sech" style={{ marginTop: 0 }}>
                        Related articles
                      </div>
                      <div className="hc-related">
                        {related.map(
                          (s) =>
                            HELP_BY_SLUG[s] && (
                              <button
                                type="button"
                                key={s}
                                className="hc-rel"
                                onClick={() => openArticle(s)}
                              >
                                <Icon name="card" size={14} />
                                <span className="hc-rel__t">{HELP_BY_SLUG[s].title}</span>
                              </button>
                            ),
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
