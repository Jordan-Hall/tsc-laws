import { expect, test } from '@playwright/test';

test.describe('login', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('shows the form', async ({ page }) => {
    await expect(page.locator('form')).toBeVisible();
  });

  test('signs in', async ({ page, context }) => {
    await page.fill('#user', 'ada');
    await page.click('text=Sign in');
    expect(context.pages()).toHaveLength(1);
  });

  test('needs an api request', async ({ request }) => {
    const response = await request.get('/api');
    expect(response.ok()).toBe(true);
  });

  test.skip('is flaky', async ({ page }) => {
    await page.goto('/flaky');
  });
});

test.use({ baseURL: 'http://localhost:3000' });
