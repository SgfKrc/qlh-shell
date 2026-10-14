import { test, expect } from '@playwright/test';
import { installIntentApi, operation } from './helpers/model_intent_api.js';

// SSE response fixtures exercise the product UI; they do not certify physical inference.
const routeMetrics = {
  engine: 'distributed_pipeline', execution_mode: 'route_a_stage_offer_v3',
  distributed_used: true, workers_used: ['worker-surface', 'worker-android'],
  layer_segments: [[0, 15], [16, 31]], generated_tokens: 42, tokens_per_second: 12.34,
  config_id: 'route_a:request_fixture', generation_id: 'gen_request_fixture',
};
const modelIdentity = {
  model_operation_id: 'supply_contract_01', model_config_id: 'config_contract', model_generation: 7,
};

async function installChatResponse(page, metrics) {
  await page.route('**/api/chat/stream', (route) => route.fulfill({
    status: 200, contentType: 'text/event-stream',
    body: [
      { token: '推理完成' },
      { done: true, response: '推理完成', metrics },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  }));
}

async function send(page) {
  await page.getByTestId('chat-input').fill('检查本次推理身份');
  await expect(page.getByTestId('chat-send')).toBeEnabled();
  await page.getByTestId('chat-send').click();
  await expect(page.locator('.msg--assistant .msg__text').last()).toHaveText('推理完成');
  const metrics = page.locator('.msg--assistant .msg__metrics').last();
  await expect(metrics).toBeVisible();
  await expect(metrics).toContainText('分布式 · 2 节点');
  await expect(metrics).toContainText('route_a_stage_offer_v3');
  await expect(metrics).toContainText('42 tokens');
  await expect(metrics).toContainText('12.3 tok/s');
  return metrics;
}

test('done identity follows the prepared operation and stays attached to that reply', async ({ page }) => {
  const state = await installIntentApi(page, { operation: operation('ready') });
  await installChatResponse(page, { ...routeMetrics, ...modelIdentity });
  await page.goto('/#/workbench?fixtures=0');
  await expect(page.getByTestId('intent-operation-id')).toHaveText(modelIdentity.model_operation_id);
  const metrics = await send(page);
  await expect(metrics).toContainText('模型准备：supply_contract_01');
  await expect(metrics).toContainText('模型配置：config_contract');
  await expect(metrics).toContainText('模型代次：7');
  await expect(metrics).not.toContainText('route_a:request_fixture');
  await expect(metrics).not.toContainText('gen_request_fixture');

  state.operation = operation('ready', { operation_id: 'supply_new', config_id: 'config_new', generation: 8 });
  await expect(page.getByTestId('intent-operation-id')).toHaveText('supply_new');
  await expect(metrics).toContainText('模型准备：supply_contract_01');
  await expect(metrics).toContainText('模型配置：config_contract');
  await expect(metrics).toContainText('模型代次：7');
  await expect(metrics).not.toContainText('supply_new');
  await expect(metrics).not.toContainText('config_new');
});

test('response identity takes precedence when the current UI operation differs', async ({ page }) => {
  await installIntentApi(page, { operation: operation('ready', {
    operation_id: 'supply_ui_current', config_id: 'config_ui_current', generation: 99,
  }) });
  await installChatResponse(page, { ...routeMetrics, ...modelIdentity });
  await page.goto('/#/workbench?fixtures=0');
  await expect(page.getByTestId('intent-operation-id')).toHaveText('supply_ui_current');
  const metrics = await send(page);
  await expect(metrics).toContainText('模型准备：supply_contract_01');
  await expect(metrics).toContainText('模型配置：config_contract');
  await expect(metrics).toContainText('模型代次：7');
  await expect(metrics).not.toContainText('ui_current');
  await expect(metrics).not.toContainText('99');
});

for (const { name, identity, expected } of [
  { name: 'legacy response', identity: {}, expected: [] },
  { name: 'operation only', identity: { model_operation_id: 'supply_response_only' }, expected: ['模型准备：supply_response_only'] },
  { name: 'config only', identity: { model_config_id: 'config_response_only' }, expected: ['模型配置：config_response_only'] },
  { name: 'generation zero', identity: { model_generation: 0 }, expected: ['模型代次：0'] },
  { name: 'empty identity', identity: { model_operation_id: '', model_config_id: null, model_generation: null }, expected: [] },
]) {
  test(`${name} shows only the model identity fields actually returned`, async ({ page }) => {
    await installIntentApi(page, { operation: operation('ready') });
    await installChatResponse(page, { ...routeMetrics, ...identity });
    await page.goto('/#/workbench?fixtures=0');
    const metrics = await send(page);
    for (const text of expected) await expect(metrics).toContainText(text);
    for (const label of ['模型准备：', '模型配置：', '模型代次：']) {
      if (!expected.some((text) => text.startsWith(label))) await expect(metrics).not.toContainText(label);
    }
    await expect(metrics).not.toContainText('supply_contract_01');
    await expect(metrics).not.toContainText('config_contract');
    await expect(metrics).not.toContainText('route_a:request_fixture');
    await expect(metrics).not.toContainText('gen_request_fixture');
  });
}

for (const [isMaster, streamingMode] of [[false, 'full'], [true, 'interactive']]) {
  test(`chat at ${isMaster ? 'master' : 'bound worker'} keeps the required distributed route`, async ({ page }) => {
    const state = await installIntentApi(page, { operation: operation('ready') });
    state.catalog.binding.is_master = isMaster;
    await installChatResponse(page, { ...routeMetrics, ...modelIdentity });
    await page.goto('/#/workbench?fixtures=0');
    const pending = page.waitForRequest((request) => request.url().includes('/api/chat/stream') && request.method() === 'POST');
    await send(page);
    const request = (await pending).postDataJSON();
    expect(request.streaming_mode).toBe(streamingMode);
    expect(request.routing_preference).toBe('distributed_required');
    expect(request.enable_thinking).toBe(false);
  });
}
