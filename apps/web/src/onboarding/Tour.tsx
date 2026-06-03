/**
 * First-run guided tour (design handoff — "Incremental Reading.html").
 *
 * A scripted, just-in-time walk over the real screens that teaches the whole loop:
 * the two schedulers → get a source → read & set a read-point → extract (the
 * pivotal gesture) → distill & card → review → hand off to the command center.
 * Each step changes route and anchors a Coachmark to a real `[data-coach]` control
 * (gracefully centering when the control isn't on screen). The Shell owns the
 * index + route driving; this module owns the step content and the rail/coach UI.
 */
import type { ReactNode } from "react";
import { Icon, type IconName } from "../components/Icon";
import { Coachmark, type Placement } from "../help/Contextual";
import { cx } from "../help/primitives";
import { Kbd } from "../shell/Kbd";

export interface TourStep {
  key: string;
  name: string;
  /** Real renderer route to show for this step. */
  route: string;
  /** `[data-coach=…]` anchor on that route, or null to center. */
  target: string | null;
  placement: Placement;
  icon: IconName;
  eyebrow: string;
  title: string;
  body: ReactNode;
  demo?: ReactNode;
}

function SchedulerDemo() {
  return (
    <div className="primer">
      <div className="primer__col">
        <span className="sched sched--fsrs">
          <Icon name="brain" size={14} /> <b>92%</b> recall
        </span>
        <span className="primer__q">Can you recall this?</span>
        <span className="primer__who">Cards · FSRS</span>
      </div>
      <div className="primer__col">
        <span className="sched sched--attn">
          <Icon name="gauge" size={14} /> Raw extract
        </span>
        <span className="primer__q">Process this again, when?</span>
        <span className="primer__who">Sources &amp; extracts</span>
      </div>
    </div>
  );
}

function ExtractDemo() {
  return (
    <div className="coach__demo">
      <div className="coach__demo-card">
        <b style={{ color: "var(--el-extract)" }}>
          <Icon name="extract" size={14} /> Extract <Kbd keys="E" />
        </b>
        <span>New scheduled item, with lineage. Comes back.</span>
      </div>
      <div className="coach__demo-card">
        <b style={{ color: "oklch(0.62 0.13 95)" }}>
          <Icon name="highlight" size={14} /> Highlight <Kbd keys="H" />
        </b>
        <span>Just a mark in place. Goes nowhere.</span>
      </div>
    </div>
  );
}

export function getTourSteps(): TourStep[] {
  return [
    {
      key: "schedulers",
      name: "Two clocks",
      route: "/queue",
      target: null,
      placement: "center",
      icon: "gauge",
      eyebrow: "The one idea to hold",
      title: "Two questions, two clocks",
      demo: <SchedulerDemo />,
      body: (
        <>
          Everything you process answers one of two questions, on two separate schedulers.{" "}
          <b>Cards</b> ask whether you can recall something. <b>Sources and extracts</b> ask whether
          it’s worth returning to. They never mix — which is why grade buttons only appear on cards.
        </>
      ),
    },
    {
      key: "source",
      name: "Get a source",
      route: "/inbox",
      target: '[data-coach="import"]',
      placement: "bottom",
      icon: "inbox",
      eyebrow: "Step 2 · Capture",
      title: "Get something in",
      body: (
        <>
          Paste a URL or text, or import a file. Good candidates are textbooks, overviews, and your
          own notes — <b>not</b> fiction or breaking news. Everything lands in the Inbox at priority{" "}
          <b>C</b> and waits for triage — the inbox is a decision gate, not a reading list.
        </>
      ),
    },
    {
      key: "read",
      name: "Read a little",
      route: "/inbox",
      target: null,
      placement: "center",
      icon: "bookmark",
      eyebrow: "Step 3 · Incremental reading",
      title: "Read a little, mark your spot",
      body: (
        <>
          Open a source, read a paragraph or two, then press <Kbd keys="␣" /> to set a read-point
          where you stopped — you’ll resume here next time. Reading happens in small increments.
          (Space only sets the point when your cursor isn’t in the text.)
        </>
      ),
    },
    {
      key: "extract",
      name: "Extract",
      route: "/inbox",
      target: null,
      placement: "center",
      icon: "extract",
      eyebrow: "Step 4 · The pivotal gesture",
      title: "Extract, don’t highlight",
      demo: <ExtractDemo />,
      body: (
        <>
          In the reader, select a sentence.{" "}
          <b>
            Extract <Kbd keys="E" />
          </b>{" "}
          lifts it into its own scheduled item that returns to you.{" "}
          <b>
            Highlight <Kbd keys="H" />
          </b>{" "}
          just marks the text in place. If you only ever highlight, the pipeline never starts.
        </>
      ),
    },
    {
      key: "distill",
      name: "Distill & card",
      route: "/queue",
      target: null,
      placement: "center",
      icon: "sparkle",
      eyebrow: "Step 5 · Refine",
      title: "Distill, then make a card",
      body: (
        <>
          Across repeated returns, refine an extract — trim, rewrite, split — advancing the stage
          from <b>raw → clean → atomic</b>. An atomic statement is card-ready. Then Convert to card.
          Distilling first is how you avoid carding everything.
        </>
      ),
    },
    {
      key: "review",
      name: "Review",
      route: "/review",
      target: '[data-coach="review-card"]',
      placement: "center",
      icon: "review",
      eyebrow: "Step 6 · Close the loop",
      title: "Review it",
      body: (
        <>
          Try to recall, press <Kbd keys="␣" /> to reveal, then grade <b>1–4</b>. The text under
          each button is when the card returns. <b>Again</b> isn’t failure — it just brings the card
          back sooner. You don’t track anything; the schedule does.
        </>
      ),
    },
    {
      key: "handoff",
      name: "You’re set",
      route: "/queue",
      target: '[data-coach="start-session"]',
      placement: "bottom",
      icon: "check",
      eyebrow: "That’s the whole loop",
      title: "This is your command center",
      body: (
        <>
          It shows your day and points you to the next action — the real work happens in{" "}
          <b>Start session</b>. Press <Kbd keys="?" /> anytime for shortcuts,{" "}
          <Kbd keys={["⌘", "K"]} /> to do anything, and find the rest in the help center.
        </>
      ),
    },
  ];
}

export function TourLayer({
  index,
  onNext,
  onPrev,
  onSkip,
}: {
  index: number | null;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
}) {
  const steps = getTourSteps();
  if (index == null || index < 0 || index >= steps.length) return null;
  const s = steps[index];
  if (!s) return null;
  const total = steps.length;
  return (
    <>
      <div className="tour-rail">
        <div className="tour-rail__label">
          <span className="tour-rail__step">Guided setup</span>
          <span className="tour-rail__name">{s.name}</span>
        </div>
        <div className="tour-rail__track">
          {steps.map((step, i) => (
            <span
              key={step.key}
              className={cx(
                "tour-rail__seg",
                i < index && "tour-rail__seg--done",
                i === index && "tour-rail__seg--on",
              )}
            />
          ))}
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onSkip}>
          Skip tour
        </button>
      </div>
      <Coachmark
        key={s.key}
        targetSel={s.target}
        placement={s.placement}
        backdrop
        icon={s.icon}
        eyebrow={s.eyebrow}
        title={s.title}
        demo={s.demo || null}
        step={index}
        total={total}
        onNext={onNext}
        onPrev={onPrev}
        nextLabel={index === total - 1 ? "Finish" : "Next"}
      >
        {s.body}
      </Coachmark>
    </>
  );
}
