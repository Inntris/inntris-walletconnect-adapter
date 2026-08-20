import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The integration suite builds and spawns real provider processes on a
    // synthetic PATH; give it room beyond vitest's 5s default.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
