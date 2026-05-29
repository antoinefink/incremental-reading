/**
 * Placeholder page (T003).
 *
 * Each of the seven routes renders one of these for now. Real screens arrive in
 * later milestones (reader M3, queue M5, review M7, inbox M2, settings M1-T011,
 * etc.). Kept deliberately thin and token-driven — no domain logic, no data.
 */
import type { IconName } from "../components/Icon";
import { Icon } from "../components/Icon";

export type PlaceholderProps = {
  icon: IconName;
  title: string;
  body: string;
  /** Stable hook for E2E route assertions. */
  routeId: string;
};

export function Placeholder({ icon, title, body, routeId }: PlaceholderProps) {
  return (
    <div
      data-testid={`route-${routeId}`}
      className="flex h-full min-h-full flex-col items-center justify-center gap-3 px-7 py-8 text-center"
    >
      <div className="grid size-12 place-items-center rounded-lg bg-accent-soft text-accent-text">
        <Icon name={icon} size={26} />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-text">{title}</h1>
      <p className="max-w-sm text-base text-text-2">{body}</p>
    </div>
  );
}
