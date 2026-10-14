import { test, expect } from '@playwright/test';
import { installIntentApi, operation, writes } from './helpers/model_intent_api.js';

const selectMaster = (page) => page.locator('.model-list__item').filter({ hasText: 'Qwen3.5 9B' }).click();
const refresh = (page) => page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
const progress = (page) => page.getByTestId('intent-progress');

test('master catalog → single intent → all automatic phases and node progress', async ({ page }, testInfo) => {
  const state = await installIntentApi(page);
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/#/models?fixtures=0');
  await expect(progress(page)).toContainText('尚无选模操作'); // JSON null is legal.
  await expect(page.getByRole('button', { name: '使用此模型', exact: true })).toBeDisabled();
  await expect(page.locator('.model-list')).not.toContainText('PC Local Model');
  await selectMaster(page);
  await page.getByRole('button', { name: '使用此模型', exact: true }).click();
  await expect(progress(page)).toContainText('supply_contract_01');
  expect(writes(state, '/api/models/intent')[0].body).toEqual({ model_id: 'qwen35-9b', engine: 'auto', quant_type: '', strategy: 'auto', timeout_seconds: 3600 });
  await expect(page.getByRole('progressbar', { name: 'worker-surface 传输进度' })).toHaveAttribute('value', '50');
  await expect(page.getByRole('progressbar', { name: 'worker-android 传输进度' })).not.toHaveAttribute('value');
  for (const status of ['waiting_nodes', 'inspecting', 'inventory', 'planning', 'building', 'supplying', 'verifying', 'preparing', 'ready']) {
    state.operation = { ...state.operation, status, loaded_ready: status === 'ready' };
    await refresh(page);
    await expect(progress(page).locator('[aria-current="step"]')).toHaveCount(1);
    await expect(progress(page).locator('.badge')).toHaveText(status.toUpperCase());
  }
  await expect(page.getByRole('link', { name: '开始聊天' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('intent-contract-ready.png'), fullPage: true });
  expect(writes(state).map((r) => r.path)).toEqual(['/api/models/intent']);
  expect(state.requests.some((r) => r.path === '/api/models/prepare-pipeline')).toBe(false);
  expect(errors).toEqual([]);
});

test('reload resumes the operation without automatically submitting a selection', async ({ page }) => {
  const state = await installIntentApi(page, { operation: operation('preparing') });
  await page.goto('/#/models?fixtures=0');
  await expect(progress(page)).toContainText('supply_contract_01');
  await page.reload();
  await expect(progress(page)).toContainText('代际 7');
  await refresh(page);
  await expect.poll(() => state.requests.some((r) => r.path === '/api/models/intent/supply_contract_01' && r.method === 'GET')).toBe(true);
  expect(writes(state)).toEqual([]);
});

test('catalog/current polling preserves explicit model, engine and quantization; missing selection cannot fall back', async ({ page }) => {
  const state = await installIntentApi(page);
  await page.goto('/#/models?fixtures=0');
  await selectMaster(page);
  await page.getByLabel('Runtime engine').selectOption('pytorch');
  await page.getByLabel('Quantization', { exact: true }).selectOption('fp16');
  state.catalog = { ...state.catalog, active_model_id: 'master-small', models: [...state.catalog.models].reverse() };
  state.operation = operation('ready', { intent: { ...operation().intent, model_id: 'master-small' } });
  await expect(progress(page)).toContainText('master-small'); // Background timer, not a user refresh.
  await expect(page.locator('.model-list__item[aria-pressed="true"]')).toContainText('Qwen3.5 9B');
  await expect(page.getByLabel('Runtime engine')).toHaveValue('pytorch');
  await expect(page.getByLabel('Quantization', { exact: true })).toHaveValue('fp16');
  await page.getByRole('button', { name: '使用此模型', exact: true }).click();
  await expect.poll(() => writes(state, '/api/models/intent').length).toBe(1);
  expect(writes(state, '/api/models/intent')[0].body).toMatchObject({ model_id: 'qwen35-9b', engine: 'pytorch', quant_type: 'fp16' });
  state.catalog = { ...state.catalog, models: state.catalog.models.filter((model) => model.model_id !== 'qwen35-9b') };
  await refresh(page);
  await expect(page.getByRole('button', { name: '使用此模型', exact: true })).toBeDisabled();
  await expect(page.locator('.model-panel--runtime')).toContainText('所选模型');
  expect(writes(state, '/api/models/intent')).toHaveLength(1);
});

test('named operation/node failure retries original intent; cancellation does not unload', async ({ page }) => {
  const failed = operation('failed', { reason_code: 'INTENT_NODE_PREPARE_FAILED', reason: 'Surface 加载失败', nodes: { surface: { status: 'failed', bytes_received: 1, total_bytes: 2, reason_code: 'WORKER_OUT_OF_MEMORY', reason: '内存不足', layer_range: [0, 31] } } });
  const state = await installIntentApi(page, { operation: failed });
  await page.goto('/#/models?fixtures=0');
  await expect(progress(page)).toContainText('INTENT_NODE_PREPARE_FAILED');
  await expect(progress(page)).toContainText('WORKER_OUT_OF_MEMORY');
  await page.locator('.model-list__item').filter({ hasText: 'Master Small' }).click();
  await page.getByRole('button', { name: '重试此操作' }).click();
  await expect(progress(page).locator('.badge')).toHaveText('QUEUED');
  expect(writes(state, '/api/models/intent')[0].body).toEqual(failed.intent);
  await page.getByRole('button', { name: '取消操作', exact: true }).click();
  await expect(progress(page).locator('.badge')).toHaveText('CANCELLED');
  expect(writes(state, '/api/models/intent/supply_contract_01')[0].method).toBe('DELETE');
  expect(writes(state, '/api/models/unload')).toEqual([]);
});

test('disconnected 409 → discover/connect with empty body → master catalog, without host or mode writes', async ({ page }) => {
  const state = await installIntentApi(page, { disconnected: true });
  await page.goto('/#/models?fixtures=0');
  await expect(progress(page)).toContainText('INTENT_MASTER_NOT_CONNECTED');
  await page.getByRole('button', { name: '发现并连接主节点', exact: true }).click();
  await expect(page.getByTestId('intent-binding')).toContainText('已绑定主节点');
  await selectMaster(page);
  await expect(page.getByRole('button', { name: '使用此模型', exact: true })).toBeEnabled();
  expect(writes(state)).toEqual([expect.objectContaining({ path: '/api/models/intent/connect', body: {} })]);
  expect(state.runtime.inference_mode).toBe('distributed');
  expect(state.requests.every((r) => new URL(r.url).origin === 'http://127.0.0.1:15184')).toBe(true);
});

test('late intent submission cannot cross a switch to local mode', async ({ page }) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const state = await installIntentApi(page, { onSubmit: async (route, body) => {
    await held;
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(operation('ready', { operation_id: 'supply_late', intent: body })) }).catch(() => {});
  } });
  await page.goto('/#/models?fixtures=0');
  await selectMaster(page);
  await page.getByRole('button', { name: '使用此模型', exact: true }).click();
  await expect.poll(() => writes(state, '/api/models/intent').length).toBe(1);
  await page.getByRole('button', { name: '退出集群，使用本地推理' }).click();
  await expect(page.locator('.model-panel--runtime')).toContainText('本机不接收集群推理任务');
  release();
  await page.locator('.model-list__item').filter({ hasText: 'PC Local Model' }).click();
  await page.getByRole('button', { name: 'Load selected', exact: true }).click();
  await expect(page.locator('.model-panel--runtime .badge')).toHaveText('LOADED');
  await expect(page.locator('.runtime-banner')).toContainText('PC Local Model');
  await expect(page.locator('body')).not.toContainText('supply_late');
  expect(writes(state, '/api/models/load')[0].body.model_id).toBe('pc-local');
});

test('late local load cannot cross rejoining distributed mode', async ({ page }) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const state = await installIntentApi(page, { runtime: { loaded: false, inference_mode: 'local' }, onLoad: async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ loaded: true, model_id: 'pc-local', inference_mode: 'local' }) }).catch(() => {});
  } });
  await page.goto('/#/models?fixtures=0');
  await page.locator('.model-list__item').filter({ hasText: 'PC Local Model' }).click();
  await page.getByRole('button', { name: 'Load selected', exact: true }).click();
  await expect.poll(() => writes(state, '/api/models/load').length).toBe(1);
  await page.getByRole('button', { name: '集群分布式', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Master model catalog' })).toBeVisible();
  release();
  await refresh(page);
  await expect(page.locator('.runtime-banner')).toContainText('No model loaded');
  expect(state.runtime.inference_mode).toBe('distributed');
  expect(state.requests.filter((r) => r.path.startsWith('/api/models/intent')).every((r) => r.method === 'GET')).toBe(true);
});

test('Chat waits for ready AND loaded_ready, then sends via the normal SSE API', async ({ page }) => {
  const state = await installIntentApi(page, { operation: operation('supplying') });
  await page.goto('/#/workbench?fixtures=0');
  await expect(progress(page)).toContainText('supply_contract_01');
  await page.getByLabel('输入消息').fill('可以开始了吗');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await page.getByLabel('输入消息').press('Enter');
  expect(writes(state, '/api/chat/stream')).toEqual([]);
  state.operation = operation('ready', { loaded_ready: false });
  await expect(progress(page).locator('.badge')).toHaveText('READY');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  state.operation = operation('ready');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.msg--assistant .msg__text')).toHaveText('真正走了发送路径');
  expect(writes(state, '/api/chat/stream')[0].body).toMatchObject({
    message: '可以开始了吗', routing_preference: 'distributed_required', enable_thinking: false, show_thinking: false,
  });
});

test('actual unload calls runtime API and stale ready history cannot re-enable Chat', async ({ page }) => {
  const state = await installIntentApi(page, { operation: operation('ready') });
  await page.goto('/#/models?fixtures=0');
  await page.getByRole('button', { name: 'Unload runtime', exact: true }).click();
  await expect(progress(page)).toContainText('运行时已卸载');
  await expect(page.locator('.runtime-banner')).toContainText('No model loaded');
  await page.goto('/#/workbench?fixtures=0'); // Hash navigation keeps the shared provider.
  await page.getByLabel('输入消息').fill('不应发送');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  expect(writes(state, '/api/models/unload')).toHaveLength(1);
  expect(writes(state, '/api/models/intent/supply_contract_01')).toEqual([]);
});

test('control fence conflicts are named and do not replace the active operation', async ({ page }) => {
  const state = await installIntentApi(page, { operation: operation('ready'), submitError: { code: 'INTENT_CONTROL_FENCE_REJECTED', message: '控制权已经变更' } });
  await page.goto('/#/models?fixtures=0');
  await selectMaster(page);
  await page.getByRole('button', { name: '使用此模型', exact: true }).click();
  await expect(progress(page)).toContainText('INTENT_CONTROL_FENCE_REJECTED');
  await expect(progress(page)).toContainText('supply_contract_01');
  expect(writes(state, '/api/models/intent')).toHaveLength(1);
});


test('a lost cached binding exposes discover/connect and keeps the selected model', async ({ page }) => {
  const state = await installIntentApi(page);
  await page.goto('/#/models?fixtures=0');
  await selectMaster(page);
  state.disconnected = true;
  await refresh(page);
  await expect(progress(page)).toContainText('INTENT_MASTER_NOT_CONNECTED');
  await expect(page.getByRole('button', { name: '使用此模型', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '发现并连接主节点', exact: true }).click();
  await expect(page.getByRole('button', { name: '使用此模型', exact: true })).toBeEnabled();
  await expect(page.locator('.model-list__item[aria-pressed="true"]')).toContainText('Qwen3.5 9B');
  expect(writes(state)).toHaveLength(1);
});

test('malformed operation is reported instead of enabling Chat or crashing the page', async ({ page }) => {
  await installIntentApi(page, { operation: {} });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/#/workbench?fixtures=0');
  await expect(progress(page)).toContainText('INTENT_CONTRACT_INVALID');
  await page.getByLabel('输入消息').fill('不应发送');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});


test('local mode keeps explicit whole-model loading and actual unload without intent forwarding', async ({ page }) => {
  const state = await installIntentApi(page, { runtime: { loaded: true, model_id: 'pc-local', model_name: 'PC Local Model', inference_mode: 'local' } });
  await page.goto('/#/models?fixtures=0');
  await expect(page.locator('.model-panel--runtime .badge')).toHaveText('LOADED');
  await page.getByRole('button', { name: 'Unload runtime', exact: true }).click();
  await expect(page.locator('.runtime-banner')).toContainText('No model loaded');
  await expect(page.getByRole('button', { name: 'Load selected', exact: true })).toBeDisabled();
  await page.locator('.model-list__item').filter({ hasText: 'PC Local Model' }).click();
  await page.getByRole('button', { name: 'Load selected', exact: true }).click();
  await expect(page.locator('.model-panel--runtime .badge')).toHaveText('LOADED');
  expect(writes(state, '/api/models/unload')).toHaveLength(1);
  expect(writes(state, '/api/models/load')[0].body).toEqual({ engine: 'llama_cpp', quant_type: 'Q4_K_M', use_compile: false, model_id: 'pc-local' });
  expect(state.requests.some((req) => req.path.startsWith('/api/models/intent'))).toBe(false);
});


test('Unix updated_at and product testids match the live backend projection', async ({ page }) => {
  const state = await installIntentApi(page, { operation: operation('preparing', { updated_at: 1791885600 }) });
  await page.goto('/#/models?fixtures=0');
  await page.getByTestId('intent-model-qwen35-9b').click();
  await page.getByTestId('intent-engine').selectOption('llama_cpp');
  await page.getByTestId('intent-quantization').selectOption('');
  await expect(progress(page).locator('time')).toHaveAttribute('datetime', '2026-10-13T10:00:00.000Z');
  await expect(page.getByTestId('intent-operation-id')).toHaveText('supply_contract_01');
  await expect(page.getByTestId('intent-generation')).toContainText('7');
  await expect(page.getByTestId('intent-node-progress')).toContainText('worker-surface');
  await page.getByTestId('intent-use-model').click();
  await expect.poll(() => writes(state, '/api/models/intent').length).toBe(1);
  expect(writes(state, '/api/models/intent')[0].body).toMatchObject({ model_id: 'qwen35-9b', engine: 'llama_cpp', quant_type: '' });
});


test('Chat request contract follows current intent mode and the thinking toggle', async ({ page }) => {
  // Request contract assertions only; intercepted SSE is not physical inference evidence.
  const state = await installIntentApi(page, { runtime: { loaded: true, model_id: 'pc-local', inference_mode: 'local' } });
  await page.goto('/#/workbench?fixtures=0');
  const thinking = page.getByRole('checkbox', { name: '思考过程', exact: true });
  await expect(thinking).not.toBeChecked();
  const sendAndCheck = async (message, route, enabled) => {
    const before = writes(state, '/api/chat/stream').length;
    await page.getByTestId('chat-input').fill(message);
    await expect(page.getByTestId('chat-send')).toBeEnabled();
    await page.getByTestId('chat-send').click();
    await expect.poll(() => writes(state, '/api/chat/stream').length).toBe(before + 1);
    await expect(page.locator('.msg--assistant .msg__text')).toHaveCount(before + 1);
    await expect(page.locator('.msg--assistant .msg__text').last()).toHaveText('真正走了发送路径');
    expect(writes(state, '/api/chat/stream')[before].body).toMatchObject({
      message, routing_preference: route, enable_thinking: enabled, show_thinking: enabled,
    });
  };
  await sendAndCheck('本地简答', 'local_only', false);
  await thinking.check();
  await sendAndCheck('本地开启思考', 'local_only', true);
  // Same mounted ChatPane: polling changes intent.mode, so the send callback must update.
  state.runtime = { loaded: false, pipeline_prepared: false, inference_mode: 'distributed' };
  state.operation = operation('ready');
  await expect(progress(page)).toContainText('supply_contract_01');
  await sendAndCheck('分布式开启思考', 'distributed_required', true);
  await thinking.uncheck();
  await sendAndCheck('分布式简答', 'distributed_required', false);
});
