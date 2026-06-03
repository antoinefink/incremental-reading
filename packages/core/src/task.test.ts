import { describe, expect, it } from "vitest";
import { isTaskType, TASK_TYPE_LABEL, TASK_TYPES, taskTypeLabel } from "./task";

describe("TASK_TYPES tuple + guard", () => {
  it("is the closed five-kind vocabulary", () => {
    expect(TASK_TYPES).toEqual([
      "verify_claim",
      "find_better_source",
      "update_outdated_card",
      "check_current_version",
      "custom",
    ]);
  });

  it("isTaskType accepts every tuple member and rejects everything else", () => {
    for (const t of TASK_TYPES) expect(isTaskType(t)).toBe(true);
    expect(isTaskType("verify")).toBe(false);
    expect(isTaskType("")).toBe(false);
    expect(isTaskType(null)).toBe(false);
    expect(isTaskType(undefined)).toBe(false);
    expect(isTaskType(42)).toBe(false);
    expect(isTaskType({})).toBe(false);
  });
});

describe("taskTypeLabel", () => {
  it("maps each kind to its human label", () => {
    expect(taskTypeLabel("verify_claim")).toBe("Verify claim");
    expect(taskTypeLabel("find_better_source")).toBe("Find better source");
    expect(taskTypeLabel("update_outdated_card")).toBe("Update outdated card");
    expect(taskTypeLabel("check_current_version")).toBe("Check current version");
    expect(taskTypeLabel("custom")).toBe("Custom task");
  });

  it("has a label for every tuple member (no gaps)", () => {
    for (const t of TASK_TYPES) {
      expect(TASK_TYPE_LABEL[t]).toBeTruthy();
      expect(taskTypeLabel(t)).toBe(TASK_TYPE_LABEL[t]);
    }
  });

  it("falls back to the custom label for an unknown kind (never throws)", () => {
    expect(taskTypeLabel("nonsense")).toBe("Custom task");
    expect(taskTypeLabel("")).toBe("Custom task");
  });
});
