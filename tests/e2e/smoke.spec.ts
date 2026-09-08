import { expect, test } from '@playwright/test';
import { apiDownBaseURL } from '../../playwright.config';

test('dashboard renders and the web app reaches the api health endpoint', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'agentic-trading — daily report' })).toBeVisible();
  // Each lane renders one of: a run table (when the store has runs), the
  // no-run empty state, or an unreachable notice — never a 500.
  await expect(page.getByTestId('lane-HK')).toBeVisible();
  await expect(page.getByTestId('lane-US')).toBeVisible();
  for (const lane of ['HK', 'US']) {
    await expect(page.getByTestId(`lane-${lane}`)).toContainText(
      /no run yet|api: unreachable|run \d+/,
    );
  }
  await expect(page.getByTestId('api-health')).toHaveText(/api: ok \(instruments: \d+\)/);
  // 3b: dashboard links into chat.
  await expect(page.getByRole('link', { name: 'Chat →' })).toBeVisible();
});

test('chat renders the not-configured state gracefully (no LLM env in e2e wiring)', async ({ page }) => {
  const response = await page.goto('/chat');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'chat' })).toBeVisible();
  // Shell renders: cost header, input disabled until a session exists.
  await expect(page.getByTestId('cost-header')).toHaveText(/calls: 0\/20 · tokens: 0\+0/);
  // The e2e api runs without LLM_* env, so POST /chat/sessions 503s → notice, no crash.
  await page.getByRole('button', { name: 'new session' }).click();
  await expect(page.getByTestId('chat-unconfigured')).toContainText('chat is not configured');
});

test('chat shell renders gracefully with the api down — unreachable notice, not a 500', async ({ page }) => {
  const response = await page.goto(`${apiDownBaseURL}/chat`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'chat' })).toBeVisible();
  await expect(page.getByTestId('chat-unreachable')).toContainText('api: unreachable');
});

test('dashboard shell renders gracefully with the api down — per-lane unreachable, not a 500', async ({ page }) => {
  const response = await page.goto(`${apiDownBaseURL}/`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'agentic-trading — daily report' })).toBeVisible();
  await expect(page.getByTestId('lane-HK')).toContainText('api: unreachable');
  await expect(page.getByTestId('lane-US')).toContainText('api: unreachable');
  await expect(page.getByTestId('api-health')).toHaveText('api: unreachable');
});
