import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { jobs } from "./jobs";

describe("job schema", () => {
  it("pins the restartable local job queue shape", () => {
    const columns = getTableColumns(jobs);

    expect(getTableName(jobs)).toBe("jobs");
    expect(Object.keys(columns)).toEqual([
      "id",
      "type",
      "status",
      "payload",
      "result",
      "error",
      "attempts",
      "maxAttempts",
      "progressRatio",
      "progressNote",
      "notBefore",
      "createdAt",
      "updatedAt",
      "startedAt",
      "finishedAt",
    ]);
    expect(columns.maxAttempts.name).toBe("max_attempts");
    expect(columns.notBefore.name).toBe("not_before");
  });
});
