import { useMemo, useState } from 'react';
import { Cpu, RefreshCw, Search, Unplug } from 'lucide-react';
import { CommandButton } from '../components/CommandButton';
import { EmptyState } from '../components/EmptyState';
import { PageHeader, SectionHead } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { ModelIntentProgress } from '../components/ModelIntentProgress';
import { useModelIntent } from '../data/ModelIntentContext';
import type { ModelIntentPayload } from '../data/types';
import { ModelOrbitCanvas } from '../visual/ModelOrbitCanvas';

export function DistributedModelsPage() {
  const intent = useModelIntent();
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [engine, setEngine] = useState<ModelIntentPayload['engine']>('auto');
  const [quant, setQuant] = useState('');
  const models = intent.catalog?.models || [];
  const selected = models.find((model) => model.model_id === selectedId);
  const filtered = useMemo(() => models.filter((model) => `${model.name} ${model.model_id} ${model.description || ''}`.toLowerCase().includes(query.trim().toLowerCase())), [models, query]);
  const binding = intent.catalog?.binding || intent.operation?.binding;
  const connected = !intent.error && binding?.status === 'connected';
  const unloaded = intent.operation && intent.unloadedOperation === `${intent.operation.operation_id}:${intent.operation.generation}`;
  const runtimeReady = intent.runtime?.loaded || intent.runtime?.pipeline_prepared || intent.chatReady;
  return <div className="models-page" data-testid="models-page">
    <ModelOrbitCanvas className="models-page__bg" />
    <div className="models-page__content">
      <PageHeader tag="MODEL LAB" title="Model workspace" description="选择模型，主节点自动完成计划、供给与推理准备。" actions={<CommandButton variant="ghost" icon={RefreshCw} busy={intent.refreshing} onClick={intent.refresh}>Refresh workspace</CommandButton>} />
      <div className="models-layout models-layout--intent">
        <aside className="models-rail"><section className="model-panel model-panel--catalog">
          <SectionHead title="Master model catalog" hint={`${models.length} models`} />
          <label className="model-search"><Search size={14} aria-hidden="true" /><span className="sr-only">Filter models</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by name or id" /></label>
          {intent.loading && !intent.catalog ? <EmptyState kind="loading" title="正在读取主节点目录" compact /> : filtered.length ? <ul className="model-list">{filtered.map((model) => <li key={model.model_id} data-selected={model.model_id === selectedId ? 'true' : undefined}><button type="button" className="model-list__item" data-testid={`intent-model-${model.model_id}`} data-model-id={model.model_id} aria-pressed={model.model_id === selectedId} onClick={() => { setSelectedId(model.model_id); setEngine('auto'); setQuant(''); }}><span className="model-list__name">{model.name}</span><span className="model-list__meta"><span>{model.model_id}</span>{model.model_id === intent.catalog?.active_model_id ? <StatusBadge label="ACTIVE" tone="info" size="sm" /> : null}</span></button></li>)}</ul> : <EmptyState title={connected ? '没有匹配的模型' : '主节点目录尚不可用'} description={connected ? '调整筛选或在主节点安装模型。' : '连接主节点后即可查看集群模型。'} compact />}
        </section></aside>
        <main className="models-main">
          <section className="model-panel model-panel--runtime">
            <div className="model-panel__head"><div><p className="mono-label">DISTRIBUTED INFERENCE</p><h2>集群选模</h2></div><StatusBadge label={intent.chatReady ? 'READY' : intent.runtime?.pipeline_prepared ? 'PREPARED' : 'WAITING'} tone={intent.chatReady ? 'ok' : 'info'} /></div>
            <div className="runtime-banner"><div className="runtime-banner__icon"><Cpu size={25} aria-hidden="true" /></div><div><strong>{(!unloaded ? intent.operation?.intent.model_id : null) || (runtimeReady ? intent.runtime?.model_name || intent.runtime?.model_id : null) || 'No model loaded'}</strong><span>{intent.chatReady ? '已就绪，可以聊天。' : '主节点将自动供给并准备模型。'}</span></div></div>
            <div className="runtime-controls"><div className="control-group"><span className="control-label">推理模式</span><div className="control-tabs" role="group" aria-label="推理模式"><button type="button" className="is-active" disabled={intent.busy === 'mode'}>集群分布式</button><button type="button" disabled={intent.loading || intent.busy === 'mode'} onClick={() => void intent.setMode('local')}>退出集群，使用本地推理</button></div><p className="model-inline-note">选模后自动供给、校验和准备，无需逐台选择层段。</p></div></div>
            <div className="intent-binding" data-testid="intent-binding"><strong>{connected ? binding?.is_master ? '本机为主节点' : '已绑定主节点' : binding?.status === 'local' ? '本机处于本地模式' : '未连接主节点'}</strong>{binding?.reason_code ? <span>{binding.reason_code}</span> : null}{!connected && !intent.loading ? <CommandButton testId="intent-connect-master" variant="ghost" size="sm" icon={RefreshCw} disabled={Boolean(intent.busy)} busy={intent.busy === 'connect'} onClick={() => void intent.connect()}>发现并连接主节点</CommandButton> : null}</div>
            {selected ? <div className="intent-selection"><h3>{selected.name}</h3><p className="detail-description">{selected.description}</p>{selected.unavailable_reason ? <p className="model-inline-note">{selected.unavailable_reason}</p> : null}<div className="runtime-controls"><label className="control-group"><span className="control-label">Engine</span><select data-testid="intent-engine" aria-label="Runtime engine" value={engine} onChange={(event) => setEngine(event.target.value as ModelIntentPayload['engine'])}>{(['auto', 'pytorch', 'llama_cpp'] as const).map((id) => <option key={id} value={id}>{id}</option>)}</select></label><label className="control-group"><span className="control-label">Quantization</span><select data-testid="intent-quantization" aria-label="Quantization" value={quant} onChange={(event) => setQuant(event.target.value)}><option value="">自动选择</option>{(selected.quant_types || []).map((id) => <option key={id} value={id}>{id}</option>)}</select></label></div></div> : <p className="model-inline-note">{selectedId ? `所选模型 ${selectedId} 已不在主节点目录，请重新选择。` : '请在主节点目录中选择要使用的模型。'}</p>}
            <div className="runtime-actions"><CommandButton testId="intent-use-model" icon={Cpu} busy={intent.busy === 'submit'} disabled={!selected || !connected || Boolean(intent.busy) || intent.loading} onClick={() => { if (selected) void intent.submit({ model_id: selected.model_id, engine, quant_type: quant, strategy: 'auto', timeout_seconds: 3600 }); }}>使用此模型</CommandButton><CommandButton variant="danger" icon={Unplug} busy={intent.busy === 'unload'} disabled={!runtimeReady || Boolean(intent.busy)} onClick={() => void intent.unload()}>Unload runtime</CommandButton></div>
          </section>
          <ModelIntentProgress />
        </main>
      </div>
    </div>
  </div>;
}
