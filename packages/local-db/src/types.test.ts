import { describe, expect, it } from "vitest";
import { createInMemoryDb } from "./test-db";
import type { DbClient, TransactionClient } from "./types";

describe("local-db shared types", () => {
  it("accepts both root Drizzle clients and transaction clients at compile time", () => {
    const handle = createInMemoryDb();
    try {
      const rootClient: DbClient = handle.db;
      expect(rootClient).toBe(handle.db);

      handle.db.transaction((tx) => {
        const transactionClient: TransactionClient = tx;
        const dbClient: DbClient = transactionClient;
        expect(dbClient).toBeDefined();
      });
    } finally {
      handle.sqlite.close();
    }
  });
});
