import type { Finding, Graph, NodeMetric, Performance, ScoreBreakdown } from './types';

export const ARCH_MAX = 63;
export const SIM_MAX = 25;
const ARCH_BASE = 7;

/** Points for each building block, once per design unless noted. */
const COMPONENT_POINTS: Partial<Record<string, number>> = {
  LoadBalancer: 5, Cache: 6, Queue: 7, Worker: 7, CDN: 5, RateLimiter: 4, APIGateway: 3, SearchIndex: 5,
};
const SERVICE_POINTS = 4;
const MAX_SERVICES_COUNTED = 4;
const ASYNC_EDGE_POINTS = 4;

function grade(fraction: number): ScoreBreakdown['grade'] {
  if (fraction >= 0.85) return 'A';
  if (fraction >= 0.72) return 'B';
  if (fraction >= 0.6) return 'C';
  if (fraction >= 0.35) return 'D';
  return 'F';
}

export function scoreDesign(graph: Graph, perf: Performance, metrics: NodeMetric[], issues: Finding[], latencyTargetMs: number | null): ScoreBreakdown {
  const contributions: ScoreBreakdown['contributions'] = [];
  const penalties: ScoreBreakdown['penalties'] = [];

  for (const [type, pts] of Object.entries(COMPONENT_POINTS)) {
    if (graph.nodes.some((n) => n.type === type)) contributions.push({ label: type, points: pts! });
  }
  const services = graph.nodes.filter((n) => n.type === 'Service').length;
  if (services) contributions.push({ label: `${services} Service node(s)`, points: SERVICE_POINTS * Math.min(services, MAX_SERVICES_COUNTED) });
  if (graph.edges.some((e) => e.connection_type === 'async')) contributions.push({ label: 'Async edges', points: ASYNC_EDGE_POINTS });

  for (const f of issues) {
    if (f.code === 'UNREACHABLE') penalties.push({ label: 'Unconnected components', points: 3 });
    if (f.code === 'QUEUE_NO_CONSUMER') penalties.push({ label: 'Queue without consumer', points: 4 });
    if (f.code === 'CYCLE') penalties.push({ label: 'Request cycle', points: 3 });
  }

  const bonus = contributions.reduce((a, c) => a + c.points, 0);
  const penalty = penalties.reduce((a, c) => a + c.points, 0);
  const valid = !issues.some((f) => f.severity === 'error' && ['EMPTY', 'NO_ENTRY', 'NO_COMPUTE'].includes(f.code));
  const arch_pts = valid ? Math.max(0, Math.min(ARCH_MAX, ARCH_BASE + bonus - penalty)) : 0;

  let sim_pts = 0;
  if (valid) {
    const hottest = Math.max(0, ...metrics.filter((m) => m.component_type !== 'User').map((m) => m.utilization));
    if (perf.error_rate > 0) sim_pts = 9;
    else {
      sim_pts = 20;
      if (hottest >= 1) sim_pts -= 2;
      if (perf.total_latency < 100) sim_pts += 4;
      if ((perf.capacity_headroom ?? 0) >= 2 && perf.total_latency < 100) sim_pts += 1;
    }
    if (latencyTargetMs && perf.total_latency > latencyTargetMs) sim_pts -= 4;
    sim_pts = Math.max(0, Math.min(SIM_MAX, sim_pts));
  }

  const total = arch_pts + sim_pts;
  const total_max = ARCH_MAX + SIM_MAX;
  return { arch_pts, arch_max: ARCH_MAX, sim_pts, sim_max: SIM_MAX, contributions, penalties, total, total_max, grade: grade(total / total_max) };
}
