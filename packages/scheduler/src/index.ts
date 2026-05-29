/**
 * @interleave/scheduler — FSRS wrapper + the topic/extract attention scheduler.
 *
 * Two distinct mental models live here (see scheduling-and-priority.md): FSRS
 * (via ts-fsrs) answers "can the user recall this?" for cards, while the custom
 * priority scheduler answers "should the user process this again, and when?" for
 * sources/topics/extracts. The real schedulers land in T028/T036; this trivial
 * export only proves the package resolves across the workspace.
 */
export const SCHEDULER_PACKAGE = "@interleave/scheduler" as const;

/** Placeholder until the schedulers are defined in T028/T036. */
export const schedulerPlaceholder = (): string => SCHEDULER_PACKAGE;
