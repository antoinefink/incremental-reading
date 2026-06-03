import { describe, expect, it } from "vitest";
import {
  addDays,
  CardSchedulerService,
  isLeech,
  nextDueAt,
  queueItemScore,
  resolveDesiredRetention,
  SCHEDULER_PACKAGE,
  SCHEDULER_REVIEW_RATINGS,
  workloadBand,
} from "./index";

describe("scheduler barrel", () => {
  it("exports representative attention, FSRS, queue, retention, and workload APIs", () => {
    expect(SCHEDULER_PACKAGE).toBe("@interleave/scheduler");
    expect(typeof addDays).toBe("function");
    expect(typeof nextDueAt).toBe("function");
    expect(typeof CardSchedulerService).toBe("function");
    expect(typeof isLeech).toBe("function");
    expect(typeof queueItemScore).toBe("function");
    expect(typeof resolveDesiredRetention).toBe("function");
    expect(typeof workloadBand).toBe("function");
    expect(SCHEDULER_REVIEW_RATINGS).toEqual(["again", "hard", "good", "easy"]);
  });
});
