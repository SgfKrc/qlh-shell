import { RefreshCw, X } from 'lucide-react';
import { routeHref } from '../app/routes';
import { intentIsActive, useModelIntent } from '../data/ModelIntentContext';
import type { ModelIntentStatus } from '../data/types';
import { CommandButton } from './CommandButton';
import { StatusBadge } from './StatusBadge';

export const intentStageLabels: Record<ModelIntentStatus, string> = {
  queued: '已排队', waiting_nodes: '等待节点', inspecting: '检查模型', inventory: '盘点资源',
  planning: '制定计划', building: '构建工件', supplying: '供给模型', verifying: '校验模型',
  preparing: '准备推理', ready: '模型就绪', failed: '准备失败', cancelled: '已取消', superseded: '已被新选模替代',
};
const nodeStageLabels: Record<string, string> = { ...intentStageLabels, downloading: '传输中', available: '工件可用', loading: '加载中', prepared: '已准备', pending: '等待中' };
const stages: ModelIntentStatus[] = ['queued', 'waiting_nodes', 'inspecting', 'inventory', 'planning', 'building', 'supplying', 'verifying', 'preparing', 'ready'];
function updateTime(value: string | number) {
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function bytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

export function ModelIntentProgress({ compact = false }: { compact?: boolean }) {
  const intent = useModelIntent();
  const operation = intent.operation;
  if (intent.mode === 'local') return compact ? (
    <div className="intent-progress" data-testid="intent-progress">
      <p>{intent.chatReady ? '本地模型已就绪，可以聊天。' : '本地模型尚未加载。'}</p>
      <CommandButton variant="ghost" size="sm" href={routeHref('models')}>选择模型</CommandButton>
    </div>
  ) : null;

  const active = intentIsActive(operation);
  const stage = operation ? intentStageLabels[operation.status] || operation.status : '';
  const stageIndex = operation ? stages.indexOf(operation.status) : -1;
  const failed = operation?.status === 'failed';
  const unloaded = operation && intent.unloadedOperation === `${operation.operation_id}:${operation.generation}`;
  const canRetry = operation && (['failed', 'cancelled', 'superseded'].includes(operation.status) || unloaded);
  return (
    <section className={`intent-progress${compact ? ' intent-progress--compact' : ''}`} data-testid="intent-progress" aria-label="模型准备进度">
      <div className="intent-progress__head">
        <div>
          <h2>{compact ? '模型准备' : '统一准备进度'}</h2>
          <p role="status" aria-live="polite">{operation ? `${operation.intent.model_id} · ${stage}` : intent.loading ? '正在读取当前选模操作…' : '尚无选模操作'}</p>
        </div>
        {operation ? <StatusBadge label={operation.status.toUpperCase()} tone={failed ? 'danger' : intent.chatReady ? 'ok' : active ? 'info' : 'idle'} /> : null}
      </div>
      {intent.error ? <p className="model-inline-error" role="alert">进度读取失败：{intent.error} <button type="button" onClick={intent.refresh}>重新读取</button></p> : null}
      {intent.actionError ? <p className="model-inline-error" role="alert">{intent.actionError}</p> : null}
      {operation ? <>
        <p className="intent-progress__identity">
          <span data-testid="intent-operation-id">{operation.operation_id}</span><span data-testid="intent-generation">代际 {operation.generation}</span>
          {operation.config_id ? <span>配置 {operation.config_id}</span> : null}
        </p>
        {!compact ? <ol className="intent-stages" aria-label="自动准备阶段">{stages.map((step, index) => (
          <li key={step} data-state={index === stageIndex ? 'current' : stageIndex > index ? 'done' : 'pending'} aria-current={step === operation.status ? 'step' : undefined}>{intentStageLabels[step]}</li>
        ))}</ol> : null}
        {operation.reason_code || operation.reason ? (
          <p className={failed ? 'model-inline-error' : 'model-inline-note'} role={failed ? 'alert' : undefined}><strong>{operation.reason_code}</strong>{operation.reason}</p>
        ) : null}
        {operation.status === 'ready' ? <p className="intent-progress__ready" role="status">{intent.chatReady ? '模型已就绪，可以开始聊天。' : unloaded ? '运行时已卸载，请重新使用此模型。' : '尚未确认推理可用，等待 loaded_ready。'}</p> : null}
        {Object.keys(operation.nodes || {}).length > 0 ? (
          <div className="intent-nodes-wrap">
            <table className="intent-nodes" data-testid="intent-node-progress">
              <caption className="sr-only">各节点模型供给与准备进度</caption>
              <thead><tr><th>节点</th><th>阶段</th><th>传输进度</th><th>层段 / 原因</th></tr></thead>
              <tbody>{Object.entries(operation.nodes).map(([nodeId, node]) => {
                const total = Number(node.total_bytes) || 0;
                const received = Math.max(0, Number(node.bytes_received) || 0);
                const percent = total > 0 ? Math.min(100, Math.max(0, received / total * 100)) : undefined;
                return <tr key={nodeId}>
                  <th scope="row">{nodeId}</th>
                  <td>{nodeStageLabels[node.status] || node.status}</td>
                  <td>
                    <progress aria-label={`${nodeId} 传输进度`} max={100} value={percent} />
                    <span>{bytes(received)} / {total > 0 ? bytes(total) : '总量待定'}{percent !== undefined ? ` · ${Math.round(percent)}%` : ''}</span>
                  </td>
                  <td>
                    {node.layer_range?.length ? <span>层 {node.layer_range.join('–')}</span> : null}
                    {node.reason_code ? <strong className="intent-node-error">{node.reason_code}</strong> : null}
                    {node.reason ? <span>{node.reason}</span> : null}
                  </td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        ) : <p className="model-inline-note">等待主节点汇报节点进度。</p>}
        {operation.updated_at ? <p className="intent-progress__identity">更新时间 <time dateTime={updateTime(operation.updated_at)}>{updateTime(operation.updated_at)}</time></p> : null}
        <div className="runtime-actions">
          {active ? <CommandButton testId="intent-cancel" variant="danger" size="sm" icon={X} busy={intent.busy === 'cancel'} disabled={Boolean(intent.busy)} onClick={() => void intent.cancel()}>取消操作</CommandButton> : null}
          {canRetry ? <CommandButton testId="intent-retry" variant="ghost" size="sm" icon={RefreshCw} busy={intent.busy === 'submit'} disabled={Boolean(intent.busy) || Boolean(intent.error) || intent.catalog?.binding.status !== 'connected'} onClick={() => void intent.retry()}>重试此操作</CommandButton> : null}
          {intent.chatReady && !compact ? <CommandButton testId="intent-open-chat" size="sm" href={routeHref('workbench')}>开始聊天</CommandButton> : null}
          {compact ? <CommandButton variant="ghost" size="sm" href={routeHref('models')}>选择模型</CommandButton> : null}
        </div>
      </> : <>
        <p className="model-inline-note">在模型页选择模型后，主节点自动完成供给、校验和准备。</p>
        {compact ? <CommandButton variant="ghost" size="sm" href={routeHref('models')}>选择模型</CommandButton> : null}
      </>}
    </section>
  );
}
