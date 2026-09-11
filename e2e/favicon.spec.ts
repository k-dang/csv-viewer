import { expect, test } from '@playwright/test';

test('loads a decodable browser favicon', async ({ page }) => {
  await page.goto('/');
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveCount(1);

  const loaded = await icon.evaluate(async (link: HTMLLinkElement) => {
    const image = new Image();
    image.src = link.href;
    try {
      await image.decode();
      return image.naturalWidth > 0;
    } catch {
      return false;
    }
  });

  expect(loaded, 'The favicon URL must return a valid image').toBe(true);
});
