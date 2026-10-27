import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { CATALOG } from '../engine/catalog';
import { useStore, type FlowNode } from '../store';

export function heatClass(u: number | undefined, status?: string) {
  if (status === 'down' || status === 'overloaded') return 'heat-critical';
  if (u == null) return '';
  if (u >= 1) return 'heat-critical';
  if (u >= 0.75) return 'heat-warn';
  if (u > 0) return 'heat-ok';
  return '';
}

function summary(kind: FlowNode['data']['kind'], config: FlowNode['data']['config']) {
  if (kind === 'User') return `${Number(config.number_of_users).toLocaleString()} users × ${config.requests_per_user}/s`;
  const parts: string[] = [];
  if (Number(config.replicas ?? 1) > 1) parts.push(`×${config.replicas}`);
  if ('hit_ratio' in config) parts.push(`${Math.round(Number(config.hit_ratio) * 100)}% hit`);
  if (Number(config.shards ?? 1) > 1) parts.push(`${config.shards} shards`);
  if (config.fanout === 'all') parts.push('calls all');
  return parts.join(' · ');
}

export const ComponentNode = memo(function ComponentNode({ id, data, selected }: NodeProps<FlowNode>) {
  const spec = CATALOG[data.kind];
  const metric = useStore((s) => s.result?.node_metrics.find((m) => m.component_id === id));
  const bottleneck = useStore((s) => s.result?.performance.bottleneck_node_id === id);
  const u = metric?.utilization;
  return (
    <div className={`cnode ${heatClass(u, metric?.status)} ${selected ? 'selected' : ''} ${bottleneck ? 'bottleneck' : ''}`}>
      {data.kind !== 'User' && <Handle type="target" position={Position.Left} />}
      <div className="cnode-body">
        <div className="cnode-head">
          <span className="code-tag">{spec.code}</span>
          <span className="cnode-title" title={String(data.config.name || spec.label)}>{String(data.config.name || spec.label)}</span>
        </div>
        <div className="cnode-meta">{id}{summary(data.kind, data.config) ? ` · ${summary(data.kind, data.config)}` : ''}</div>
        {metric && data.kind !== 'User' && (
          <div className="cnode-metrics">
            <span>{Math.round(metric.incoming_rps).toLocaleString()} rps</span>
            <span>{Math.round(metric.utilization * 100)}%</span>
            <span>{Math.round(metric.latency)} ms</span>
          </div>
        )}
        {metric && data.kind !== 'User' && (
          <div className="cnode-gauge"><div style={{ width: `${Math.min(100, metric.utilization * 100)}%` }} /></div>
        )}
      </div>
      {spec.passThrough !== 'none' && <Handle type="source" position={Position.Right} />}
    </div>
  );
});
