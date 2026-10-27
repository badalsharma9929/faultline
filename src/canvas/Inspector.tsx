import { CATALOG, type ParamSpec } from '../engine/catalog';
import { useShallow } from 'zustand/react/shallow';
import { outgoingShares } from '../presetGraph';
import { useStore, type FlowEdge } from '../store';

function Field({ spec, value, onChange }: { spec: ParamSpec; value: unknown; onChange: (v: number | string | boolean) => void }) {
  if (spec.kind === 'toggle') {
    return (
      <label className="field field-toggle" title={spec.hint}>
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        <span>{spec.label}</span>
      </label>
    );
  }
  if (spec.kind === 'select') {
    return (
      <label className="field" title={spec.hint}>
        <span>{spec.label}</span>
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {spec.options.map((o) => <option key={o}>{o}</option>)}
        </select>
      </label>
    );
  }
  return (
    <label className="field" title={spec.hint}>
      <span>{spec.label}{spec.unit ? ` (${spec.unit})` : ''}</span>
      <input
        type="number"
        value={Number(value ?? 0)}
        min={spec.min}
        max={spec.max}
        step={spec.step ?? 1}
        onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))}
      />
      {spec.hint && <small>{spec.hint}</small>}
    </label>
  );
}

function TrafficShare({ edgeId, source, siblings, onChange }: { edgeId: string; source: string; siblings: FlowEdge[]; onChange: (pct: number) => void }) {
  const shares = outgoingShares(siblings);
  const pct = Math.round((shares.get(edgeId) ?? 1) * 1000) / 10;
  if (siblings.length < 2) {
    return <p className="muted share-note">Carries all of {source}'s outgoing traffic. Add another connection from {source} to split it.</p>;
  }
  return (
    <div className="share">
      <label className="field">
        <span>Traffic share (% of {source}'s outgoing)</span>
        <div className="share-row">
          <input type="range" min={0} max={100} step={1} value={pct} aria-label="Traffic share slider" onChange={(e) => onChange(Number(e.target.value))} />
          <input type="number" min={0} max={100} step={1} value={pct} aria-label="Traffic share percent" onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))} />
        </div>
      </label>
      <ul className="share-list">
        {siblings.map((e) => (
          <li key={e.id} className={e.id === edgeId ? 'current' : ''}>
            <span>→ {e.target}</span>
            <b>{Math.round((shares.get(e.id) ?? 0) * 100)}%</b>
          </li>
        ))}
      </ul>
      <small className="muted">Other connections from {source} keep their proportions of the rest. Reads vs writes, hot vs cold paths.</small>
    </div>
  );
}

export function Inspector() {
  const selectedId = useStore((s) => s.selectedId);
  const node = useStore((s) => s.nodes.find((n) => n.id === s.selectedId));
  const edge = useStore((s) => s.edges.find((e) => e.id === s.selectedId));
  const metric = useStore((s) => s.result?.node_metrics.find((m) => m.component_id === s.selectedId));
  const siblings = useStore(useShallow((s) => (edge ? s.edges.filter((e) => e.source === edge.source) : [])));
  const outgoing = useStore((s) => (node ? s.edges.filter((e) => e.source === node.id).length : 0));
  const sourceCallsAll = useStore((s) => (edge ? s.nodes.find((n) => n.id === edge.source)?.data.config.fanout === 'all' : false));
  const { updateConfig, setEdgeType, setEdgeShare, removeSelected } = useStore.getState();

  if (!selectedId || (!node && !edge)) {
    return <div className="inspector empty">Select a component or connection to edit it. Drag from a node's right handle to connect.</div>;
  }

  if (edge) {
    const t = edge.data?.connection_type ?? 'sync';
    return (
      <div className="inspector">
        <h3>Connection</h3>
        <p className="muted">{edge.source} → {edge.target}</p>
        <div className="seg">
          <button className={t === 'sync' ? 'on' : ''} onClick={() => setEdgeType(edge.id, 'sync')}>Sync</button>
          <button className={t === 'async' ? 'on' : ''} onClick={() => setEdgeType(edge.id, 'async')}>Async</button>
        </div>
        <p className="muted">Async hops don't add to the caller's latency.</p>
        {sourceCallsAll ? (
          <p className="muted share-note">{edge.source} calls all of its connections, so every request it serves also goes down this one. Switch {edge.source} to Split to give connections shares.</p>
        ) : (
          <TrafficShare edgeId={edge.id} source={edge.source} siblings={siblings} onChange={(pct) => setEdgeShare(edge.id, pct)} />
        )}
        <button className="danger" onClick={removeSelected}>Delete connection</button>
      </div>
    );
  }

  const spec = CATALOG[node!.data.kind];
  return (
    <div className="inspector">
      <h3>{spec.label}</h3>
      <label className="field">
        <span>Name</span>
        <input value={String(node!.data.config.name ?? '')} onChange={(e) => updateConfig(node!.id, 'name', e.target.value)} />
      </label>
      {outgoing > 1 && (
        <div className="field">
          <span>Fan-out</span>
          <div className="seg" role="group" aria-label="Fan-out">
            <button className={node!.data.config.fanout !== 'all' ? 'on' : ''} onClick={() => updateConfig(node!.id, 'fanout', 'split')}>Split</button>
            <button className={node!.data.config.fanout === 'all' ? 'on' : ''} onClick={() => updateConfig(node!.id, 'fanout', 'all')}>Call all</button>
          </div>
          <small>
            {node!.data.config.fanout === 'all'
              ? 'Every request calls every connection; it waits for the slowest sync call and fails if any of them fails.'
              : 'Each request takes one connection, by its traffic share. Use Call all when every request needs all of them.'}
          </small>
        </div>
      )}
      {spec.params.map((p) => (
        <Field key={p.key} spec={p} value={node!.data.config[p.key]} onChange={(v) => updateConfig(node!.id, p.key, v)} />
      ))}
      {metric && node!.data.kind !== 'User' && (
        <dl className="metric-list">
          <dt>Incoming</dt><dd>{metric.incoming_rps.toLocaleString()} rps</dd>
          <dt>Capacity</dt><dd>{metric.effective_capacity.toLocaleString()} rps</dd>
          <dt>Busy</dt><dd>{Math.round(metric.utilization * 100)}%</dd>
          <dt>Latency</dt><dd>{metric.latency} ms (queue {metric.queue_delay_ms} ms)</dd>
          <dt>p95 / p99</dt><dd>{Math.round(metric.latency_p95_ms)} / {Math.round(metric.latency_p99_ms)} ms</dd>
          <dt>Dropped</dt><dd>{metric.overflow.toLocaleString()} rps</dd>
        </dl>
      )}
      <button className="danger" onClick={removeSelected}>Delete component</button>
    </div>
  );
}
