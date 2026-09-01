import { expect, test } from '@playwright/test';

test('placeholder page renders and the web app reaches the api health endpoint', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'agentic-trading' })).toBeVisible();
  await expect(page.getByText(/Phase 0 scaffold/)).toBeVisible();
  await expect(page.getByTestId('api-health')).toHaveText(/api: ok \(instruments: \d+\)/);
});
