/**
 * Card review types (T005).
 *
 * These describe FSRS active-recall scheduling, which applies to **cards only**.
 * Sources/topics/extracts are scheduled by the separate attention scheduler and
 * must NOT be forced into this model (a load-bearing invariant: cards answer
 * "can the user recall this?", everything else answers "should the user process
 * this again, and when?"). Every review writes a durable {@link ReviewLog} row
 * so history is auditable and FSRS parameters can later be optimized.
 *
 * Framework-agnostic: the actual FSRS algorithm lives in `packages/scheduler`
 * (wrapping `ts-fsrs`, T036); this file only models the persisted state/log.
 */

import type { FsrsState, ReviewRating } from "./enums";
import type { ElementId, IsoTimestamp, ReviewLogId } from "./ids";

/**
 * The persisted FSRS memory state for one card (`review_states` table, keyed by
 * the card's element id). Mutated after each review by the scheduler.
 */
export interface ReviewState {
  /** The card element this state belongs to (one-to-one). */
  readonly elementId: ElementId;
  /** Next due time; the queue/review session reads this. */
  dueAt: IsoTimestamp | null;
  /** FSRS memory stability (days); higher = slower forgetting. */
  stability: number;
  /** FSRS item difficulty. */
  difficulty: number;
  /** Days since the previous review when this state was computed. */
  elapsedDays: number;
  /** Interval (days) FSRS scheduled at the previous review. */
  scheduledDays: number;
  /** Total successful-enough repetitions. */
  reps: number;
  /** Total lapses (failed reviews); drives leech detection. */
  lapses: number;
  /** Current FSRS phase. */
  fsrsState: FsrsState;
  /** When this card was last reviewed; `null` for a brand-new card. */
  lastReviewedAt: IsoTimestamp | null;
}

/**
 * One immutable review event (`review_logs` table). Appended every time the user
 * grades a card; it snapshots the rating, response time, and the FSRS state
 * before/after so the session is repairable and history-rich. Never updated in
 * place — corrections are new rows.
 */
export interface ReviewLog {
  readonly id: ReviewLogId;
  /** The card element that was reviewed. */
  readonly elementId: ElementId;
  readonly rating: ReviewRating;
  readonly reviewedAt: IsoTimestamp;
  /** Time-to-answer in milliseconds (reveal → grade). */
  readonly responseMs: number;
  /** FSRS state captured immediately before this review. */
  readonly prevState: FsrsState;
  /** FSRS state assigned by this review. */
  readonly nextState: FsrsState;
  /** Card stability after this review (days). */
  readonly nextStability: number;
  /** Card difficulty after this review. */
  readonly nextDifficulty: number;
  /** Due time scheduled by this review. */
  readonly nextDueAt: IsoTimestamp;
}
