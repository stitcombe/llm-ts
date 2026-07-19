import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    // Tests manipulate LLM_USER_PATH and cwd; run files sequentially within
    // a file but allow parallel files (each test file uses its own tmp dirs).
    pool: "forks",
  },
});
