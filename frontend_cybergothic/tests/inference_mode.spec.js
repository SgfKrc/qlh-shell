import { test, expect } from '@playwright/test';

test('手动本地模式卸载已有运行时，重新加入后恢复分布式默认', async ({ page }) => {
  await page.goto('/#/models?fixtures=1');
  await expect(page.locator('.runtime-banner')).toContainText('Qwen 1.8B Chat');
  await page.getByRole('button', { name: '退出集群，使用本地推理' }).click();
  await expect(page.locator('.runtime-banner')).toContainText('No model loaded');
  await expect(page.getByRole('button', { name: 'Prepare pipeline', exact: true })).toBeDisabled();
  await expect(page.getByText('本机不接收集群推理任务。切回分布式时先卸载本地模型。')).toBeVisible();
  await page.getByRole('button', { name: 'Load selected', exact: true }).click();
  await expect(page.locator('.model-panel--runtime .badge')).toHaveText('LOADED');
  await page.getByRole('button', { name: '集群分布式', exact: true }).click();
  await expect(page.locator('.runtime-banner')).toContainText('No model loaded');
  await expect(page.getByRole('button', { name: 'Prepare pipeline', exact: true })).toBeEnabled();
});

test('已准备的层段显示 PREPARED 并允许卸载', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path === '/api/models/current') body = { loaded: false, pipeline_prepared: true, inference_mode: 'distributed', model_id: 'large-9b' };
    if (path === '/api/models') body = { models: [] };
    if (path === '/api/models/available') body = { available_engines: [] };
    if (path === '/api/models/local-assets') body = { assets: [] };
    if (path === '/api/models/gguf') body = { models: [] };
    if (path === '/api/models/registry') body = { models: [] };
    if (path === '/api/cluster/my-role') body = { is_master: true, node_role: 'master', run_mode: 'distributed' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/#/models?fixtures=0');
  await expect(page.locator('.model-panel--runtime .badge')).toHaveText('PREPARED');
  await expect(page.locator('.runtime-banner')).toContainText('large-9b');
  await expect(page.getByRole('button', { name: 'Unload runtime', exact: true })).toBeEnabled();
});
