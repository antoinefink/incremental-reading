import { describe, expect, it } from "vitest";
import { createInMemoryDb } from "./db";
import { seedDemoCollection } from "./factories";
import {
  createInMemoryDb as exportedCreateInMemoryDb,
  seedDemoCollection as exportedSeedDemoCollection,
  TESTING_PACKAGE,
} from "./index";

describe("@interleave/testing barrel", () => {
  it("exports the testing package marker and primary helpers by identity", () => {
    expect(TESTING_PACKAGE).toBe("@interleave/testing");
    expect(exportedCreateInMemoryDb).toBe(createInMemoryDb);
    expect(exportedSeedDemoCollection).toBe(seedDemoCollection);
  });
});
