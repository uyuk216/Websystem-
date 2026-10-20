import { defineConfig } from 'vitest/config';

// e2e/ is Playwright's; vitest only runs test/.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
