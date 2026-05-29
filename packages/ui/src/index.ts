/**
 * @interleave/ui — shared UI components built from the design kit.
 *
 * Houses the reusable primitives (SchedulerChip, LineageTree, MetaRow, TypeIcon,
 * Prio/Stage/Status, etc.) derived from design/tokens.css and lucide-react. No
 * components exist yet — this trivial export only proves the package resolves
 * across the workspace.
 */
export const UI_PACKAGE = "@interleave/ui" as const;

/** Placeholder until shared components are defined (T004/T010+). */
export const uiPlaceholder = (): string => UI_PACKAGE;
