import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as api from './api';
import { currentModelFixture, modelIntentCatalogFixture, modelIntentOperationFixture } from './fixtures';
import type { CurrentModelResponse, ModelIntentCatalog, ModelIntentOperation, ModelIntentPayload } from './types';
import { pushToast } from '../components/Toast';
import { useRegisterRefresh } from '../app/refreshBus';

type Mode = 'distributed' | 'local';
interface IntentState {
  runtime: CurrentModelResponse | null;
  catalog: ModelIntentCatalog | null;
  operation: ModelIntentOperation | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
  actionError: string;
  busy: string;
  unloadedOperation: string;
}
interface ModelIntentContextValue extends IntentState {
  mode: Mode;
  chatReady: boolean;
  refresh: () => void;
  submit: (intent: ModelIntentPayload) => Promise<void>;
  retry: () => Promise<void>;
  cancel: () => Promise<void>;
  connect: () => Promise<void>;
  setMode: (mode: Mode) => Promise<void>;
  loadLocal: (engine: string, quant: string, modelId: string) => Promise<void>;
  unload: () => Promise<void>;
}

const Context = createContext<ModelIntentContextValue | null>(null);
const terminal = new Set(['ready', 'failed', 'cancelled', 'superseded']);
export const intentIsActive = (operation: ModelIntentOperation | null) => Boolean(operation && !terminal.has(operation.status));
const operationKey = (op: ModelIntentOperation | null) => op ? `${op.operation_id}:${op.generation}` : '';
const initialState = (): IntentState => ({
  runtime: null, catalog: null, operation: null, loading: true, refreshing: false,
  error: '', actionError: '', busy: '', unloadedOperation: '',
});

/** One operation follows the user across Models, workbench and sessions. */
export function ModelIntentProvider({ children, usingFixtures }: { children: ReactNode; usingFixtures: boolean }) {
  const [state, setState] = useState<IntentState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const epoch = useRef(0);
  const readSequence = useRef(0);
  const readRef = useRef<AbortController | null>(null);
  const writeRef = useRef<AbortController | null>(null);
  const alive = useRef(false);

  const refresh = useCallback(async (replace = true) => {
    if (!alive.current || writeRef.current || (!replace && readRef.current)) return;
    readRef.current?.abort();
    const controller = new AbortController();
    readRef.current = controller;
    const requestEpoch = epoch.current;
    const sequence = ++readSequence.current;
    const valid = () => alive.current && !controller.signal.aborted && epoch.current === requestEpoch && readSequence.current === sequence;
    setState((previous) => ({ ...previous, refreshing: true }));
    try {
      if (usingFixtures) {
        if (valid()) setState((previous) => ({ ...previous,
          runtime: previous.runtime || { ...currentModelFixture, inference_mode: 'distributed' },
          catalog: previous.runtime?.inference_mode === 'local' ? null : modelIntentCatalogFixture,
          operation: previous.runtime?.inference_mode === 'local' || previous.unloadedOperation ? null : previous.operation || modelIntentOperationFixture,
          loading: false, refreshing: false, error: '',
        }));
        return;
      }
      const runtime = await api.fetchCurrentModel(controller.signal);
      if (!valid()) return;
      const mode = runtime.inference_mode || 'distributed';
      // Publish a known mode even when the master's intent API is unavailable.
      setState((previous) => ({ ...previous, runtime,
        ...(mode === 'local' ? { catalog: null, operation: null } : {}),
      }));
      if (mode === 'local') {
        setState((previous) => ({ ...previous, loading: false, refreshing: false, error: '' }));
        return;
      }
      const [catalog, current] = await Promise.all([
        api.fetchModelIntentCatalog(controller.signal), api.fetchCurrentModelIntent(controller.signal),
      ]);
      if (!valid()) return;
      // /current restores an operation on reload and discovers superseding requests.
      // The operation endpoint provides the same progress projection used by cancel.
      const operation = current && current.operation_id === stateRef.current.operation?.operation_id
        ? await api.fetchModelIntent(current.operation_id, controller.signal) : current;
      if (!valid()) return;
      setState((previous) => ({ ...previous, catalog, operation, loading: false, refreshing: false, error: '' }));
    } catch (err) {
      if (!valid()) return;
      setState((previous) => ({ ...previous, loading: false, refreshing: false, error: api.describeError(err) }));
    } finally {
      if (valid()) readRef.current = null;
    }
  }, [usingFixtures]);

  useEffect(() => {
    alive.current = true;
    epoch.current += 1;
    setState(initialState());
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh(false);
    }, 2000);
    const onVisible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      epoch.current += 1;
      readRef.current?.abort();
      writeRef.current?.abort();
      writeRef.current = null;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);
  useRegisterRefresh(refresh);

  const act = useCallback(async (
    action: string,
    task: (signal: AbortSignal) => Promise<Partial<IntentState>>,
    message: string,
    supersede = false,
  ) => {
    if (writeRef.current && !supersede) return;
    readRef.current?.abort();
    writeRef.current?.abort();
    const controller = new AbortController();
    writeRef.current = controller;
    const requestEpoch = ++epoch.current;
    const valid = () => alive.current && !controller.signal.aborted && requestEpoch === epoch.current;
    setState((previous) => ({ ...previous, busy: action, refreshing: false, actionError: '' }));
    try {
      const patch = await task(controller.signal);
      if (!valid()) return;
      setState((previous) => ({ ...previous, ...patch, error: '', busy: '' }));
      pushToast(message, usingFixtures ? 'info' : 'ok');
    } catch (err) {
      if (!valid()) return;
      const error = api.describeError(err);
      setState((previous) => ({ ...previous, busy: '', actionError: error }));
      pushToast(error, 'danger');
    } finally {
      if (valid()) {
        writeRef.current = null;
        void refresh();
      }
    }
  }, [refresh, usingFixtures]);

  const submit = useCallback(async (intent: ModelIntentPayload) => {
    if (stateRef.current.runtime?.inference_mode === 'local') return;
    if (usingFixtures) {
      pushToast('演示数据模式下不提交选模操作。请关闭演示数据后连接真实集群。', 'warn');
      return;
    }
    await act('submit', async (signal) => ({ operation: await api.submitModelIntent(intent, signal), unloadedOperation: '' }), '已提交选模，后端将自动供给并准备模型');
  }, [act, usingFixtures]);

  const retry = useCallback(async () => {
    const operation = stateRef.current.operation;
    if (operation) await submit({ ...operation.intent });
  }, [submit]);

  const cancel = useCallback(async () => {
    const operation = stateRef.current.operation;
    if (!operation || !intentIsActive(operation) || usingFixtures) return;
    await act('cancel', async (signal) => {
      await api.cancelModelIntent(operation.operation_id, signal);
      return { operation: await api.fetchModelIntent(operation.operation_id, signal) };
    }, '已请求取消选模操作');
  }, [act, usingFixtures]);

  const setMode = useCallback(async (mode: Mode) => {
    if (stateRef.current.busy === 'mode' || mode === (stateRef.current.runtime?.inference_mode || 'distributed')) return;
    await act('mode', async (signal) => {
      if (!usingFixtures) {
        const result = await api.setInferenceMode(mode, signal);
        if (!result.success) throw new Error('inference_mode_failed：后端未完成模式切换。');
      }
      return { runtime: { loaded: false, pipeline_prepared: false, model_id: null, inference_mode: mode }, catalog: null, operation: null,
        unloadedOperation: usingFixtures ? 'mode-switch' : '' };
    }, mode === 'local' ? '已退出集群推理，可在本机加载整模' : '已卸载本地模型并重新加入集群推理', true);
  }, [act, usingFixtures]);

  const loadLocal = useCallback(async (engine: string, quant: string, modelId: string) => {
    if (stateRef.current.runtime?.inference_mode !== 'local') return;
    await act('load', async (signal) => {
      const runtime = usingFixtures
        ? { loaded: true, model_id: modelId, model_name: modelIntentCatalogFixture.models.find((model) => model.model_id === modelId)?.name, engine, quant_type: quant, inference_mode: 'local' as const }
        : await api.loadModel(engine, quant, false, modelId, signal);
      return { runtime: { ...runtime, inference_mode: 'local' } };
    }, usingFixtures ? 'Fixture runtime loaded' : '本地模型加载完成');
  }, [act, usingFixtures]);

  const unload = useCallback(async () => {
    const key = operationKey(stateRef.current.operation);
    await act('unload', async (signal) => {
      const runtime = usingFixtures ? { ...stateRef.current.runtime, loaded: false } : await api.unloadModel(signal);
      return { runtime: { ...runtime, loaded: false, pipeline_prepared: false, model_id: null, inference_mode: stateRef.current.runtime?.inference_mode || 'distributed' }, unloadedOperation: key };
    }, usingFixtures ? 'Fixture runtime unloaded' : '运行时已卸载');
  }, [act, usingFixtures]);

  const connect = useCallback(async () => {
    if (usingFixtures) return;
    await act('connect', async (signal) => {
      await api.connectModelIntentMaster(signal);
      return {};
    }, '已连接发现的主节点');
  }, [act, usingFixtures]);

  const mode = state.runtime?.inference_mode || 'distributed';
  const chatReady = !state.loading && !state.busy && !state.error && (mode === 'local'
    ? state.runtime?.loaded === true
    : state.catalog?.binding.status === 'connected' && (state.operation
      ? state.operation.status === 'ready' && state.operation.loaded_ready && state.unloadedOperation !== operationKey(state.operation)
      : false));
  return <Context.Provider value={{ ...state, mode, chatReady, refresh, submit, retry, cancel, connect, setMode, loadLocal, unload }}>{children}</Context.Provider>;
}

export function useModelIntent() {
  const context = useContext(Context);
  if (!context) throw new Error('ModelIntentProvider is required');
  return context;
}
