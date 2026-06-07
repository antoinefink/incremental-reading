import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "site",
    environment: "node",
    include: ["src/**/*.test.ts", "vite.config.test.ts", "vitest.config.test.ts"],
  },
});
