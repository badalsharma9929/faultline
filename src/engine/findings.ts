import { COMPUTE_TYPES, STORAGE_TYPES } from './catalog';
import type { Finding, Graph, NodeMetric, Performance } from './types';

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** Design advice derived from topology and simulated load. */
export function analyzeDesign(graph: Graph, metrics: NodeMetric[], perf: Performance): Finding[] {
  const findings: Finding[] = [];
  const has = (t: string) => graph.nodes.some((n) => n.type === t);
  const byId = new Map(metrics.map((m) => [m.component_id, m]));

  for (const m of metrics) {
    if (m.status === 'overloaded' && m.async_only) {
      findings.push({
        code: 'BACKLOG', severity: 'warning', nodeIds: [m.component_id],
        title: `${m.component_id} falls behind`,
        detail: `Jobs arrive at ${fmt(m.incoming_rps)}/s but it finishes ${fmt(m.effective_capacity)}/s, so the backlog grows by ${fmt(m.overflow)}/s. Users don't wait, but the work is delayed without limit.`,
      });
    } else if (m.status === 'overloaded') {
      findings.push({
        code: 'OVERLOADED', severity: 'error', nodeIds: [m.component_id],
        title: `${m.component_id} is overloaded`,
        detail: `It receives ${fmt(m.incoming_rps)} rps but can serve ${fmt(m.effective_capacity)}; ${fmt(m.overflow)} rps are dropped.`,
      });
    } else if (m.status === 'down' && m.incoming_rps > 0) {
      findings.push({ code: 'DOWN', severity: 'error', nodeIds: [m.component_id], title: `${m.component_id} is down`, detail: 'Every request routed through it fails.' });
    }
  }
  if (perf.bottleneck_node_id && perf.system_status === 'degrading' && byId.get(perf.bottleneck_node_id)!.status !== 'overloaded') {
    const m = byId.get(perf.bottleneck_node_id)!;
    findings.push({
      code: 'HOT_NODE', severity: 'warning', nodeIds: [m.component_id],
      title: `${m.component_id} runs at ${Math.round(m.utilization * 100)}%`,
      detail: 'Queueing delay grows fast above 75% busy. Add replicas or move load off this node.',
    });
  }

  const singles = graph.nodes.filter((n) => [...COMPUTE_TYPES, 'Database', 'LoadBalancer'].includes(n.type) && Number(n.config.replicas ?? 1) <= 1 && !n.config.autoscaling);
  if (singles.length) {
    findings.push({
      code: 'SPOF', severity: 'warning', nodeIds: singles.map((n) => n.id),
      title: 'Single points of failure', detail: `${singles.map((n) => n.id).join(', ')} run as one instance; losing it takes the path down.`,
    });
  }

  const storesReachedDirectly = graph.edges.some((e) => {
    const s = graph.nodes.find((n) => n.id === e.source);
    const t = graph.nodes.find((n) => n.id === e.target);
    return s && t && COMPUTE_TYPES.includes(s.type) && STORAGE_TYPES.includes(t.type);
  });
  if (!has('Cache') && storesReachedDirectly) {
    findings.push({ code: 'NO_CACHE', severity: 'info', title: 'Every read hits storage', detail: 'A cache in front of the database absorbs hot reads and cuts latency.' });
  }
  if (!has('RateLimiter') && !graph.nodes.some((n) => n.type === 'APIGateway')) {
    findings.push({ code: 'NO_RATE_LIMIT', severity: 'info', title: 'No protection against floods', detail: 'Add a Rate Limiter or API Gateway in front of your services.' });
  }
  const noBackups = graph.nodes.filter((n) => n.type === 'Database' && !n.config.backups);
  if (noBackups.length) {
    findings.push({ code: 'NO_BACKUPS', severity: 'info', nodeIds: noBackups.map((n) => n.id), title: 'No database backups', detail: 'Replicas copy mistakes too; only backups give you a recovery point.' });
  }

  for (const q of graph.nodes.filter((n) => n.type === 'Queue')) {
    if (!graph.edges.some((e) => e.source === q.id)) {
      findings.push({ code: 'QUEUE_NO_CONSUMER', severity: 'warning', nodeIds: [q.id], title: `${q.id} has no consumer`, detail: 'Connect a Worker so queued jobs are processed.' });
    }
  }
  for (const e of graph.edges) {
    const t = graph.nodes.find((n) => n.id === e.target);
    if (t?.type === 'Queue' && e.connection_type !== 'async') {
      findings.push({ code: 'SYNC_INTO_QUEUE', severity: 'info', nodeIds: [e.source], title: 'Synchronous edge into a queue', detail: 'Mark it async so callers do not wait on background work.' });
    }
  }
  return findings;
}
