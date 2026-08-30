import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.js"],
    include: ["tests/**/*.test.js"],
    exclude: ["tests/live/**/*.test.js"],
    fileParallelism: false,
    pool: "forks",
  },
});
