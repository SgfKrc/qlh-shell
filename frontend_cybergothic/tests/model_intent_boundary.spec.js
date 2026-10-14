import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { installIntentApi, operation } from './helpers/model_intent_api.js';

// Construct raw wire numbers from decimal text: a JS number fixture would already be rounded.
const GENERATION = '1760000000000000901';
const NEXT_GENERATION = '1760000000000000902';
const CONTENT = String.raw`literal {"generation":1760000000000000901,"model_generation":1760000000000000902}; escaped \"generation\"; slash \\; 中文`;
function rawOperation(generation, overrides = {}) {
  const fields = operation('preparing', { reason: CONTENT, ...overrides });
  delete fields.generation;
  return `{"generation":${generation},${JSON.stringify(fields).slice(1)}`;
}

async function send(page) {
  await page.getByTestId('chat-input').fill('identity boundary');
  await expect(page.getByTestId('chat-send')).toBeEnabled();
  await page.getByTestId('chat-send').click();
}

test('raw intent integers stay exact through submit, current, operation polling and reload', async ({ page }) => {
  await installIntentApi(page);
  let current = 'null';
  const reads = [];
  await page.route('**/api/models/intent/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/current') || path.endsWith('/supply_contract_01')) {
      reads.push(path);
      return route.fulfill({ contentType: 'application/json', body: current });
    }
    return route.fallback();
  });
  await page.route('**/api/models/intent', (route) => {
    current = rawOperation(GENERATION);
    return route.fulfill({ status: 202, contentType: 'application/json', body: current });
  });
  await page.goto('/#/models?fixtures=0');
  await page.locator('.model-list__item').filter({ hasText: 'Qwen3.5 9B' }).click();
  await page.getByRole('button', { name: '使用此模型', exact: true }).click();
  await expect(page.getByTestId('intent-generation')).toHaveText(`代际 ${GENERATION}`);
  await expect(page.getByTestId('intent-progress')).toContainText(CONTENT);
  current = rawOperation(NEXT_GENERATION);
  await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
  await expect(page.getByTestId('intent-generation')).toHaveText(`代际 ${NEXT_GENERATION}`);
  expect(reads).toContain('/api/models/intent/supply_contract_01');
  await page.reload();
  await expect(page.getByTestId('intent-generation')).toHaveText(`代际 ${NEXT_GENERATION}`);
  await expect(page.getByTestId('intent-progress')).toContainText(CONTENT);
});

test('raw SSE model generation displays its original decimal and leaves token/response strings intact', async ({ page }) => {
  await installIntentApi(page, { operation: operation('ready') });
  const body = ': processing\n\n' +
    `data: {"token":${JSON.stringify(CONTENT)}}\n\n` +
    `data: {"done":true,"response":${JSON.stringify(CONTENT)},"metrics":{"model_generation":${GENERATION},"generated_tokens":3}}\n\n`;
  await page.route('**/api/chat/stream', (route) => route.fulfill({ contentType: 'text/event-stream', body }));
  await page.goto('/#/workbench?fixtures=0');
  await send(page);
  await expect(page.locator('.msg--assistant .msg__text').last()).toHaveText(CONTENT);
  await expect(page.locator('.msg--assistant .msg__metrics').last()).toContainText(`模型代次：${GENERATION}`);
  await expect(page.locator('.msg--assistant .msg__metrics').last()).toContainText('3 tokens');
});

test('raw conversation JSON retains the identity of a historical reply', async ({ page }) => {
  await installIntentApi(page, { operation: operation('ready') });
  await page.route('**/api/conversations?**', (route) => route.fulfill({
    contentType: 'application/json',
    body: `{"messages":[{"role":"assistant","content":${JSON.stringify(CONTENT)},"metrics":{"model_generation":${GENERATION}}}]}`,
  }));
  await page.goto('/#/workbench?fixtures=0');
  await expect(page.locator('.msg--assistant .msg__text').last()).toHaveText(CONTENT);
  await expect(page.locator('.msg--assistant .msg__metrics').last()).toContainText(`模型代次：${GENERATION}`);
});

test('identity JSON parsing respects strings, escaped keys, safe numbers and invalid JSON', async ({ page }) => {
  await page.goto('/#/help?fixtures=1');
  const result = await page.evaluate(async ({ generation, content }) => {
    const { parseModelIdentityJson } = await import('/src/data/parseModelIdentityJson.ts');
    const source = String.raw`{"\u0067eneration":${generation},"text":${JSON.stringify(content)},"array":["generation",${generation},{"model_generation":-9007199254740992}],"safe":{"generation":9007199254740991},"zero":{"generation":0},"fraction":{"generation":1.5},"exponent":{"generation":1e3},"quoted":{"model_generation":"9007199254740993"},"generated_tokens":42}`;
    const parsed = parseModelIdentityJson(source);
    const invalid = ['{"generation":09007199254740993}', '{"generation":9007199254740993.}', '{"generation":9007199254740993', '{"text":"unterminated}'];
    return { parsed, rejected: invalid.map((json) => {
      try { parseModelIdentityJson(json); return false; } catch { return true; }
    }) };
  }, { generation: GENERATION, content: CONTENT });
  expect(result.parsed).toEqual({
    generation: GENERATION, text: CONTENT,
    array: ['generation', Number(GENERATION), { model_generation: '-9007199254740992' }],
    safe: { generation: 9007199254740991 }, zero: { generation: 0 },
    fraction: { generation: 1.5 }, exponent: { generation: 1000 },
    quoted: { model_generation: '9007199254740993' }, generated_tokens: 42,
  });
  expect(result.rejected).toEqual([true, true, true, true]);
});

test('user stop after a real HTTP processing comment closes the SSE body and releases its reader', async ({ page }) => {
  let closed = false;
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': processing\n\n');
    res.on('close', () => { closed = true; });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/stream`;
    await installIntentApi(page, { operation: operation('ready') });
    await page.addInitScript(({ endpoint }) => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url || input.href, location.href);
        if (url.pathname !== '/api/chat/stream') return originalFetch(input, init);
        const response = await originalFetch(endpoint, init);
        const state = window.__chatBody = { commentSeen: false, reads: 0, released: 0, body: response.body };
        const getReader = response.body.getReader.bind(response.body);
        response.body.getReader = (...args) => {
          const reader = getReader(...args);
          const read = reader.read.bind(reader);
          const release = reader.releaseLock.bind(reader);
          reader.read = async () => {
            state.reads += 1;
            const chunk = await read();
            if (chunk.value) state.commentSeen ||= new TextDecoder().decode(chunk.value).includes(': processing');
            return chunk;
          };
          reader.releaseLock = () => { state.released += 1; release(); };
          return reader;
        };
        return response;
      };
    }, { endpoint });
    await page.goto('/#/workbench?fixtures=0');
    await send(page);
    await expect.poll(() => page.evaluate(() => window.__chatBody?.commentSeen)).toBe(true);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.locator('.msg--assistant .msg__error').last()).toHaveText('已取消');
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    await expect.poll(() => closed).toBe(true);
    expect(await page.evaluate(() => ({
      reads: window.__chatBody.reads,
      released: window.__chatBody.released,
      locked: window.__chatBody.body.locked,
    }))).toEqual({ reads: 2, released: 1, locked: false });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('stream retains the 10 second headers budget and clears it before a long body', async ({ page }) => {
  await page.goto('/#/help?fixtures=1');
  const result = await page.evaluate(async () => {
    const api = await import('/src/data/api.ts');
    const originalFetch = window.fetch;
    const originalSetTimeout = window.setTimeout;
    const budgets = [];
    // Compress only the headers timer, so an uncleared timer would abort the open body.
    window.setTimeout = (callback, delay, ...args) => {
      budgets.push(delay);
      return originalSetTimeout(callback, delay === 10_000 ? 0 : delay, ...args);
    };
    let user;
    try {
      window.fetch = (_input, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true });
      });
      let timeoutKind;
      try { await api.streamChat('headers'); } catch (error) { timeoutKind = error.kind; }
      let readComment;
      const firstRead = new Promise((resolve) => { readComment = resolve; });
      let cancelled = 0;
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(': processing\n\n')); },
        cancel() { cancelled += 1; },
      });
      let fetchSignal;
      window.fetch = async (_input, init) => {
        fetchSignal = init.signal;
        const response = new Response(body);
        const getReader = body.getReader.bind(body);
        body.getReader = () => {
          const reader = getReader();
          const read = reader.read.bind(reader);
          reader.read = async () => { const chunk = await read(); if (chunk.value) readComment(); return chunk; };
          return reader;
        };
        return response;
      };
      user = new AbortController();
      const pending = api.streamChat('body', { signal: user.signal }).then(
        () => 'completed', (error) => error.name,
      );
      await firstRead;
      await new Promise((resolve) => originalSetTimeout(resolve, 20));
      const abortedBeforeUser = fetchSignal.aborted;
      user.abort();
      return { timeoutKind, budgets, abortedBeforeUser, outcome: await pending, cancelled, locked: body.locked };
    } finally {
      user?.abort();
      window.fetch = originalFetch;
      window.setTimeout = originalSetTimeout;
    }
  });
  expect(result).toEqual({ timeoutKind: 'timeout', budgets: [10_000, 10_000], abortedBeforeUser: false, outcome: 'AbortError', cancelled: 1, locked: false });
});

test('stream releases readers on success and failure, and stops same-chunk tokens after abort', async ({ page }) => {
  await page.goto('/#/help?fixtures=1');
  const result = await page.evaluate(async () => {
    const api = await import('/src/data/api.ts');
    const originalFetch = window.fetch;
    const results = {};
    try {
      for (const mode of ['success', 'missingDone', 'bodyError', 'callbackAbort']) {
        const user = new AbortController();
        const tokens = [];
        const body = new ReadableStream({
          start(controller) {
            if (mode === 'bodyError') { controller.error(new TypeError('disconnected')); return; }
            controller.enqueue(new TextEncoder().encode('data: {"token":"first"}\n\ndata: {"token":"second"}\n\n' + (mode === 'missingDone' ? '' : 'data: {"done":true,"response":"complete"}\n\n')));
            if (mode !== 'callbackAbort') controller.close();
          },
        });
        window.fetch = async () => new Response(body);
        let outcome;
        try {
          const response = await api.streamChat(mode, { signal: user.signal, onToken: (token) => {
            tokens.push(token);
            if (mode === 'callbackAbort') user.abort();
          } });
          outcome = response.content;
        } catch (error) { outcome = user.signal.aborted ? error.name : error.kind; }
        results[mode] = { outcome, tokens, locked: body.locked };
      }
      return results;
    } finally { window.fetch = originalFetch; }
  });
  expect(result).toEqual({
    success: { outcome: 'complete', tokens: ['first', 'second'], locked: false },
    missingDone: { outcome: 'network', tokens: ['first', 'second'], locked: false },
    bodyError: { outcome: 'network', tokens: [], locked: false },
    callbackAbort: { outcome: 'AbortError', tokens: ['first'], locked: false },
  });
});
