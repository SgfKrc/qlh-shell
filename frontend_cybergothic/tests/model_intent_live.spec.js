import { test, expect } from '@playwright/test';

// Explicit read-only live smoke. No route doubles and no model/control mutations.
// Passing this does not certify supply/prepare or physical multi-node inference.
test('live intent catalog/current render and refresh without writing a selection', async ({ page }, testInfo) => {
  test.skip(process.env.QLH_INTENT_LIVE !== '1', 'Set QLH_INTENT_LIVE=1 with a running backend; skipped is not passed.');
  const writes = [];
  const errors = [];
  page.on('request', (req) => { if (req.url().includes('/api/') && req.method() !== 'GET') writes.push(req.url()); });
  page.on('pageerror', (err) => errors.push(String(err)));
  const catalogResponse = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/models/intent/catalog');
  const currentResponse = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/models/intent/current');
  await page.goto('/#/models?fixtures=0');
  const catalogHttp = await catalogResponse;
  const currentHttp = await currentResponse;
  expect(catalogHttp.status()).toBe(200);
  expect(currentHttp.status()).toBe(200);
  const catalog = await catalogHttp.json();
  const current = await currentHttp.json();
  expect(catalog.binding.status).toBe('connected');
  expect(catalog.models.length).toBeGreaterThan(0);
  for (const model of catalog.models) {
    expect(model).not.toHaveProperty('model_path');
    expect(model).not.toHaveProperty('gguf_path');
    expect(model).not.toHaveProperty('expected_paths');
  }
  await expect(page.locator('.model-list > li')).toHaveCount(catalog.models.length);
  const firstId = catalog.models[0].model_id;
  await page.locator('.model-list__item').first().click();
  await expect(page.locator('.model-list__item[aria-pressed="true"]')).toContainText(firstId);
  await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh workspace', exact: true })).toBeEnabled();
  await expect(page.locator('.model-list__item[aria-pressed="true"]')).toContainText(firstId);
  await expect(page.getByRole('button', { name: '使用此模型', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('intent-live-catalog.png'), fullPage: true });
  await page.goto('/#/workbench?fixtures=0');
  await page.getByLabel('输入消息').fill('只读门控检查，不发送');
  if (!current || current.status !== 'ready' || !current.loaded_ready) {
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  }
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
