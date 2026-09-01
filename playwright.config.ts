import { execSync } from 'child_process';
import { defineConfig, devices } from '@playwright/test';
import path from 'path';

// Resolve an available port once and cache it in an environment variable so
// the main Playwright process and any worker processes all use the same port.
function resolvePort(envName: string, preferred: number, fallbackStart: number): number {
  const cached = process.env[envName];
  if (cached) {
    const parsed = parseInt(cached, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  const portScript = path.join(__dirname, 'scripts', 'find-port.cjs');
  const portOutput = execSync(`node "${portScript}" ${preferred} ${fallbackStart}`, {
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
    .toString()
    .trim();
  const port = parseInt(portOutput, 10);
  if (Number.isNaN(port)) {
    throw new Error(`Failed to resolve an available port. Script output: "${portOutput}"`);
  }
  process.env[envName] = String(port);
  return port;
}

// Disjoint fallback pools: concurrent probe-then-bind can never collide.
const apiPort = resolvePort('PLAYWRIGHT_API_PORT', 3001, 3100);
const webPort = resolvePort('PLAYWRIGHT_WEB_PORT', 3000, 3200);
const apiURL = `http://localhost:${apiPort}`;
const baseURL = `http://localhost:${webPort}`;

console.log(`[playwright] api: ${apiURL}  web: ${baseURL}`);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    // Desktop Chrome only for now — add mobile projects when there's real UI.
    {
      name: 'Desktop Chrome',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      // api with dummy wiring: deterministic market data, zero network.
      // Requires a prior build (root test:e2e script runs pnpm build first).
      command: `node apps/api/dist/main.js`,
      url: `${apiURL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
      env: {
        PORT: String(apiPort),
        NODE_ENV: 'test',
        MARKET_DATA_PROVIDER: 'dummy',
        MARKET_DATA_TEST_MODE: '1',
      },
    },
    {
      command: `pnpm --filter @agentic-trading/web start --port ${webPort}`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
      env: {
        API_INTERNAL_URL: apiURL,
      },
    },
  ],
});
