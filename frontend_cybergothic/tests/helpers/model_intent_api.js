// Browser contract doubles. These tests do not certify physical cluster inference.
export const masterModels = [
  { model_id: 'qwen35-9b', name: 'Qwen3.5 9B', is_available: false, supported_engines: ['pytorch', 'llama_cpp'], quant_types: ['fp16', 'Q4_K_M'], description: 'Master catalog model, not installed on this PC.' },
  { model_id: 'master-small', name: 'Master Small', quant_types: ['int4'] },
];
export function operation(status = 'queued', overrides = {}) {
  return {
    operation_id: 'supply_contract_01',
    intent: { model_id: 'qwen35-9b', engine: 'auto', quant_type: '', strategy: 'auto', timeout_seconds: 3600 },
    status, reason_code: null, reason: null, config_id: 'config_contract', generation: 7,
    loaded_ready: status === 'ready', plan: { strategy: 'auto' }, updated_at: '2026-10-13T10:00:00Z',
    nodes: {
      'worker-surface': { status: 'supplying', bytes_received: 512, total_bytes: 1024, reason_code: null, reason: null, layer_range: [0, 15] },
      'worker-android': { status: 'waiting_nodes', bytes_received: 0, total_bytes: 0, reason_code: null, reason: null, layer_range: [16, 31] },
    },
    ...overrides,
  };
}

export async function installIntentApi(page, overrides = {}) {
  const state = {
    runtime: { loaded: false, pipeline_prepared: false, inference_mode: 'distributed' },
    catalog: { models: masterModels, active_model_id: 'master-small', binding: { status: 'connected', is_master: false, master_host: '10.0.0.8', master_api_port: 8000, reason_code: null } },
    operation: null, disconnected: false, submitError: null, onSubmit: null, onLoad: null, requests: [],
    ...overrides,
  };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const body = req.postData() ? req.postDataJSON() : null;
    state.requests.push({ method, path, body, url: req.url() });
    const respond = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/models/current') return respond(state.runtime);
    if (path === '/api/models/intent/connect') {
      state.disconnected = false;
      state.catalog.binding = { ...state.catalog.binding, status: 'connected', reason_code: null };
      return respond({ connected: true, binding: state.catalog.binding });
    }
    if (path.startsWith('/api/models/intent')) {
      if (state.disconnected) return respond({ detail: { code: 'INTENT_MASTER_NOT_CONNECTED', message: '主节点尚未连接' } }, 409);
      if (path === '/api/models/intent/catalog') return respond(state.catalog);
      if (path === '/api/models/intent/current') return respond(state.operation);
      if (path === '/api/models/intent' && method === 'POST') {
        if (state.submitError) return respond({ detail: state.submitError }, 409);
        if (state.onSubmit) return state.onSubmit(route, body, state);
        state.operation = operation('queued', { intent: body, generation: (state.operation?.generation || 7) + 1 });
        return respond(state.operation, 202);
      }
      if (method === 'DELETE') {
        state.operation = { ...state.operation, status: 'cancelled', loaded_ready: false };
        return respond(state.operation);
      }
      if (state.operation && path === `/api/models/intent/${state.operation.operation_id}`) return respond(state.operation);
      return respond({ detail: { reason_code: 'INTENT_OPERATION_NOT_FOUND' } }, 404);
    }
    if (path === '/api/models/inference-mode') {
      state.runtime = { loaded: false, pipeline_prepared: false, inference_mode: body.mode };
      state.operation = null;
      return respond({ success: true, changed: true, mode: body.mode });
    }
    if (path === '/api/models/load') {
      if (state.onLoad) return state.onLoad(route, body, state);
      state.runtime = { loaded: true, model_id: body.model_id, model_name: 'PC Local Model', engine: body.engine, quant_type: body.quant_type, inference_mode: 'local' };
      return respond(state.runtime);
    }
    if (path === '/api/models/unload') {
      state.runtime = { ...state.runtime, loaded: false, pipeline_prepared: false, model_id: null };
      return respond(state.runtime);
    }
    if (path === '/api/chat/stream') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"token":"真正走了发送路径"}\n\ndata: {"done":true,"response":"真正走了发送路径","metrics":{"distributed_used":true,"workers_used":["surface","android"]}}\n\n' });
    const other = {
      '/api/health': { status: 'ok' },
      '/api/models': { models: [{ model_id: 'pc-local', name: 'PC Local Model', is_available: true, supported_engines: ['llama_cpp'], preferred_engine: 'llama_cpp', quant_types: ['Q4_K_M'], default_quant_type: 'Q4_K_M' }] },
      '/api/models/available': { models: [], available_engines: [{ id: 'llama_cpp' }] },
      '/api/models/local-assets': { assets: [] }, '/api/models/registry': { models: [] }, '/api/models/gguf': { models: [] },
      '/api/cluster/my-role': { is_master: false, is_client: true, node_role: 'client', run_mode: 'distributed' },
      '/api/cluster/nodes': { nodes: [], count: 0, online_count: 0 },
      '/api/sessions': { sessions: [{ id: 'default', title: '新对话', message_count: 0 }], active_session_id: 'default' },
      '/api/conversations': { messages: [] }, '/api/logs/recent': { logs: [], count: 0 },
    };
    return respond(other[path] || {});
  });
  return state;
}
export const writes = (state, path) => state.requests.filter((req) => req.method !== 'GET' && (!path || req.path === path));
