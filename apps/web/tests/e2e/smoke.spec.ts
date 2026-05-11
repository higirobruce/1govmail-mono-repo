import { test, expect } from '@playwright/test';

test.describe('e2e infra smoke', () => {
  test('browser boots and offline toggle works', async ({ context, page }) => {
    await page.goto('about:blank');

    expect(await page.evaluate(() => navigator.onLine)).toBe(true);

    await context.setOffline(true);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);

    await context.setOffline(false);
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  });
});
