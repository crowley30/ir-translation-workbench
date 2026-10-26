import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 15000,
    // ZIP resource fixtures are intentionally CPU heavy. Serialize files so the
    // cloud acceptance command does not compete with other suites for the budget.
    maxWorkers: 1,
    fileParallelism: false,
  },
});
