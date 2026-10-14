import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { installIntentApi, operation } from './helpers/model_intent_api.js';

// Isolated browser/API doubles only; these tests never call a physical chat service.
const GENERATION = '1791918091977630100';
const OLD_GENERATION = '1791916805306663300';
const REPLY = 'LL mock reply 2';
const messages = Array.from({ length: 8 }, (_, index) => [
  { role: 'user', content: `Old DL question ${index + 1}` },
  { role: 'assistant', content: index % 2 ? '6' : '2', metrics: { model_generation: OLD_GENERATION } },
]).flat();

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function installHistory(page, { delayed = true, responseMessages = messages } = {}) {
  const gate = deferred();
  const requests = [];
  await page.route('**/api/conversations?**', async (route) => {
    requests.push(new URL(route.request().url()).searchParams.get('session_id'));
    if (delayed) await gate.promise;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ messages: responseMessages }) });
  });
  return { requests, release: () => gate.resolve() };
}

async function installLongStream(page) {
  const streams = [];
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const stream = { request: JSON.parse(body), startedAt: Date.now(), closed: false, res };
      streams.push(stream);
      res.on('close', () => { stream.closed = true; });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': processing\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/stream`;
  await page.addInitScript(({ endpoint }) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url || input.href, location.href);
      if (url.pathname !== '/api/chat/stream') return originalFetch(input, init);
      window.__chatPostAttempts = (window.__chatPostAttempts || 0) + 1;
      const response = await originalFetch(endpoint, init);
      window.__chatStreams = (window.__chatStreams || 0) + 1;
      return response;
    };
  }, { endpoint });
  return {
    streams,
    token(index, token) { streams[index].res.write(`data: ${JSON.stringify({ token })}\n\n`); },
    done(index, response = REPLY) {
      // Raw wire integer, so the product JSON parser must preserve all 19 digits.
      streams[index].res.end(`data: {"done":true,"response":${JSON.stringify(response)},"metrics":{"distributed_used":true,"workers_used":["surface","android"],"generated_tokens":1,"model_operation_id":"supply_ll_mock","model_config_id":"config_ll_mock","model_generation":${GENERATION}}}\n\n`);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function evidence(page, testInfo, name, extra = {}) {
  const snapshot = await page.evaluate(() => ({
    turns: document.querySelectorAll('.chat__turns > .msg').length,
    assistants: [...document.querySelectorAll('.msg--assistant .msg__text')].map((node) => node.textContent),
    metrics: [...document.querySelectorAll('.msg__metrics')].map((node) => ({
      textContent: node.textContent, innerText: node.innerText, transform: getComputedStyle(node).textTransform,
    })),
    progress: document.querySelector('[data-testid="intent-progress"]')?.innerText,
    bodyText: document.body.innerText,
  }));
  const path = testInfo.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify({ ...extra, ...snapshot }, null, 2));
  await testInfo.attach(`${name}.json`, { path, contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  return snapshot;
}

async function expectSendBlocked(page, stream, draft = 'Current LL question') {
  const input = page.getByTestId('chat-input');
  const attempts = await page.evaluate(() => window.__chatPostAttempts || 0);
  await input.fill(draft);
  await expect(page.getByTestId('chat-send')).toBeDisabled();
  await expect(page.locator('.composer__hint')).toHaveText('正在读取会话历史，完成后可发送');
  // The same callback must protect keyboard and form submission, independent of disabled UI.
  await input.press('Enter');
  await page.locator('.composer').evaluate((form) => form.requestSubmit());
  await page.getByTestId('chat-send').dispatchEvent('click');
  expect(await page.evaluate(() => window.__chatPostAttempts || 0)).toBe(attempts);
  expect(stream.streams).toHaveLength(attempts);
  await expect(input).toHaveValue(draft);
}

for (const phase of ['initial load', 'refresh']) {
  test(`delayed history ${phase} cannot erase a long SSE reply or its exact model generation`, async ({ page }, testInfo) => {
    const state = await installIntentApi(page, { operation: operation('ready', { generation: GENERATION, operation_id: 'supply_ll_mock' }) });
    let history = await installHistory(page, { delayed: phase === 'initial load' });
    const stream = await installLongStream(page);
    try {
      await page.goto('/#/workbench?fixtures=0');
      await expect(page.getByTestId('intent-generation')).toContainText(GENERATION);
      if (phase === 'refresh') {
        await expect(page.locator('.chat__turns > .msg')).toHaveCount(16);
        // Also keep an already opened delete confirmation safe while the list is replaced.
        await page.getByRole('button', { name: '删除这一轮对话' }).first().click();
        history = await installHistory(page);
        await page.getByRole('button', { name: '刷新会话历史' }).click();
        await expect(page.getByRole('button', { name: '清空当前会话历史' })).toBeDisabled();
        await expect(page.getByRole('button', { name: '删除这一轮对话' }).first()).toBeDisabled();
        await expect(page.getByRole('button', { name: '确认', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: '清空当前会话历史' }).dispatchEvent('click');
        await page.getByRole('button', { name: '确认', exact: true }).dispatchEvent('click');
        expect(state.requests.some((request) => request.path === '/api/chat/clear' || request.path.includes('/turns/'))).toBe(false);
      }
      await expect(page.getByText('正在读取会话历史', { exact: true })).toBeVisible();
      await expectSendBlocked(page, stream);
      await evidence(page, testInfo, '01-history-pending-send-blocked', { historyRequests: history.requests });
      history.release();
      await expect(page.getByText('正在读取会话历史', { exact: true })).toHaveCount(0);
      await expect(page.locator('.chat__turns > .msg')).toHaveCount(16);
      await expect(page.getByTestId('chat-send')).toBeEnabled();
      await page.getByTestId('chat-send').click();
      await expect.poll(() => stream.streams.length).toBe(1);
      await expect.poll(() => page.evaluate(() => window.__chatStreams)).toBe(1);
      stream.token(0, 'LL partial');
      await expect(page.locator('.msg--assistant .msg__text').last()).toHaveText('LL partial');
      await expect(page.locator('.chat__turns > .msg')).toHaveCount(18);
      const historyReads = history.requests.length;
      await expect(page.getByRole('button', { name: '刷新会话历史' })).toBeDisabled();
      await page.getByRole('button', { name: '刷新会话历史' }).dispatchEvent('click');
      expect(history.requests).toHaveLength(historyReads);
      await evidence(page, testInfo, '02-placeholder-survives-long-sse');
      await expect.poll(() => Date.now() - stream.streams[0].startedAt, { timeout: 15_000 }).toBeGreaterThan(10_000);
      stream.done(0);
      await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
      const snapshot = await evidence(page, testInfo, '03-sse-done', { request: stream.streams[0].request });
      expect(snapshot.turns).toBe(18);
      expect(snapshot.assistants.at(-1)).toBe(REPLY);
      expect(snapshot.bodyText).toContain(`模型代次：${GENERATION}`);
      expect(snapshot.metrics.at(-1)).toEqual(expect.objectContaining({
        transform: 'uppercase',
        textContent: expect.stringContaining(`模型代次：${GENERATION}`),
        innerText: expect.stringContaining(`模型代次：${GENERATION}`),
      }));
      expect(stream.streams[0].request).toMatchObject({
        session_id: 'default', message: 'Current LL question',
        streaming_mode: 'full', routing_preference: 'distributed_required',
      });
      // A subsequent history refresh still loads persisted turns with the same identity.
      await installHistory(page, { delayed: false, responseMessages: [
        ...messages, { role: 'user', content: 'Current LL question' },
        { role: 'assistant', content: REPLY, metrics: { model_generation: GENERATION } },
      ] });
      await page.getByRole('button', { name: '刷新会话历史' }).click();
      await expect(page.locator('.chat__turns > .msg')).toHaveCount(18);
      await expect(page.locator('.msg--assistant .msg__text').last()).toHaveText(REPLY);
      await expect(page.locator('.msg__metrics').last()).toContainText(`模型代次：${GENERATION}`);
      expect(stream.streams).toHaveLength(1);
    } finally {
      history.release();
      await stream.close();
    }
  });
}

test('history failure releases the send gate without discarding the draft', async ({ page }) => {
  await installIntentApi(page, { operation: operation('ready') });
  const gate = deferred();
  await page.route('**/api/conversations?**', async (route) => {
    await gate.promise;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'history unavailable' }) });
  });
  try {
    await page.goto('/#/workbench?fixtures=0');
    await page.getByTestId('chat-input').fill('Keep my draft');
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await page.getByTestId('chat-input').press('Enter');
    gate.resolve();
    await expect(page.getByText('会话历史加载失败', { exact: true })).toBeVisible();
    await expect(page.getByTestId('chat-input')).toHaveValue('Keep my draft');
    await expect(page.getByTestId('chat-send')).toBeEnabled();
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.locator('.msg--assistant .msg__text')).toHaveText('真正走了发送路径');
  } finally { gate.resolve(); }
});

async function installSessions(page) {
  let activeSession = 'default';
  await page.route('**/api/sessions**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/activate')) {
      activeSession = path.split('/').at(-2);
      return route.fulfill({ json: { success: true } });
    }
    return route.fulfill({ json: {
      sessions: [
        { id: 'default', title: 'Old DL session', message_count: 16 },
        { id: 'other', title: 'Other session', message_count: 0 },
      ], active_session_id: activeSession,
    } });
  });
}

test('late history from an abandoned session cannot replace the active session turns', async ({ page }) => {
  await installIntentApi(page, { operation: operation('ready') });
  await installSessions(page);
  const gate = deferred();
  let oldRequests = 0;
  let oldFulfilled = 0;
  await page.route('**/api/conversations?**', async (route) => {
    const sessionId = new URL(route.request().url()).searchParams.get('session_id');
    if (sessionId === 'default') { oldRequests += 1; await gate.promise; }
    await route.fulfill({ json: { messages: sessionId === 'default' ? messages : [
      { role: 'user', content: 'Other history question' },
      { role: 'assistant', content: 'Other history reply' },
    ] } });
    if (sessionId === 'default') oldFulfilled += 1;
  });
  try {
    await page.goto('/#/workbench?fixtures=0');
    await expect.poll(() => oldRequests).toBeGreaterThan(0);
    await page.getByRole('button', { name: /^Other session/ }).click();
    await expect(page.locator('.chat__eyebrow')).toContainText('other');
    await expect(page.locator('.msg--assistant .msg__text')).toHaveText('Other history reply');
    gate.resolve();
    await expect.poll(() => oldFulfilled).toBe(oldRequests);
    await page.getByTestId('chat-input').fill('Other session question');
    await expect(page.getByTestId('chat-send')).toBeEnabled();
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.locator('.msg--assistant .msg__text')).toHaveText(['Other history reply', '真正走了发送路径']);
    await expect(page.getByText('Old DL question 1', { exact: true })).toHaveCount(0);
  } finally { gate.resolve(); }
});

test('session switch closes the previous long SSE and gates the new session history', async ({ page }) => {
  await installIntentApi(page, { operation: operation('ready') });
  await installSessions(page);
  const initial = await installHistory(page, { delayed: false, responseMessages: [] });
  const stream = await installLongStream(page);
  let nextHistory;
  try {
    await page.goto('/#/workbench?fixtures=0');
    await page.getByTestId('chat-input').fill('Old session stream');
    await expect(page.getByTestId('chat-send')).toBeEnabled();
    await page.getByTestId('chat-input').press('Enter');
    await expect.poll(() => stream.streams.length).toBe(1);
    stream.token(0, 'Old session partial');
    await expect(page.locator('.msg--assistant .msg__text')).toHaveText('Old session partial');
    nextHistory = await installHistory(page, { responseMessages: [] });
    await page.getByRole('button', { name: /^Other session/ }).click();
    await expect(page.locator('.chat__eyebrow')).toContainText('other');
    await expect.poll(() => stream.streams[0].closed).toBe(true);
    await expectSendBlocked(page, stream, 'New session stream');
    nextHistory.release();
    await expect(page.getByTestId('chat-send')).toBeEnabled();
    await page.locator('.composer').evaluate((form) => form.requestSubmit());
    await expect.poll(() => stream.streams.length).toBe(2);
    stream.token(1, 'New session partial');
    await expect(page.locator('.msg--assistant .msg__text')).toHaveText('New session partial');
    stream.done(0, 'Old session late completion');
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    stream.done(1, 'New session complete');
    await expect(page.locator('.msg--assistant .msg__text')).toHaveText('New session complete');
    await expect(page.locator('.chat__turns > .msg')).toHaveCount(2);
    await expect(page.locator('.msg__metrics')).toContainText(`模型代次：${GENERATION}`);
    expect(stream.streams.map((item) => item.request.session_id)).toEqual(['default', 'other']);
  } finally {
    initial.release();
    nextHistory?.release();
    await stream.close();
  }
});
