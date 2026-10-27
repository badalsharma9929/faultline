import { simulate } from './simulate';
import type { ComponentType, Graph, NodeMetric, NodeOverride, SimOptions } from './types';

export const RAMP = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];
export const ERROR_BUDGET = 0.01;
/** Share of dropped requests retried per allowed retry (3× spike on a 2-replica Service → 170%, as observed). */
const RETRY_SHARE = 0.2;

export interface RampPoint {
  x: number;
  rps: number;
  latency_ms: number;
  error: number;
  hottest: string | null;
  hottest_utilization: number;
  load: Record<string, number>;
}

export interface ScenarioResult {
  id: string;
  area: string;
  name: string;
  description: string;
  pass: boolean;
  served: number;
  latency_ms: number;
  why: string[];
  skipped?: string;
}

export interface StressReport {
  load_rps: number;
  breaks_at_rps: number | null;
  first_to_give: string | null;
  headroom: number | null;
  pass: boolean;
  ramp: RampPoint[];
  scenarios: ScenarioResult[];
}

interface ScenarioDef {
  id: string;
  area: string;
  name: string;
  description: string;
  appliesTo: ComponentType[] | 'any';
  /** Returns overrides and an optional traffic scale, or a reason to skip. */
  build: (graph: Graph, base: NodeMetric[]) => { overrides?: Record<string, NodeOverride>; trafficScale?: number } | string;
}

const ofType = (g: Graph, ...types: ComponentType[]) => g.nodes.filter((n) => types.includes(n.type));
const each = (ids: string[], o: NodeOverride) => Object.fromEntries(ids.map((id) => [id, o]));
const replicaLoss = (g: Graph, id: string): NodeOverride => {
  const n = g.nodes.find((x) => x.id === id)!;
  return Number(n.config.replicas ?? 1) > 1 ? { replicasDelta: -1 } : { down: true };
};

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'spike', area: 'Traffic', name: '3× traffic spike', appliesTo: 'any',
    description: 'A launch or a viral post triples the requests arriving at once.',
    build: () => ({ trafficScale: 3 }),
  },
  {
    id: 'lose-busiest', area: 'Traffic', name: 'Lose an instance of the busiest node', appliesTo: 'any',
    description: 'The hottest component loses one instance. With only one, it goes down.',
    build: (g, base) => {
      const hot = base.filter((m) => m.component_type !== 'User').sort((a, b) => b.utilization - a.utilization)[0];
      return hot ? { overrides: { [hot.component_id]: replicaLoss(g, hot.component_id) } } : 'nothing to remove';
    },
  },
  {
    id: 'db-write-surge', area: 'Database', name: 'Write surge', appliesTo: ['Database'],
    description: 'Writes triple. Read replicas do not help: every write lands on the primary.',
    build: (g) => ({
      overrides: Object.fromEntries(ofType(g, 'Database').map((n) => {
        const r = Number(n.config.read_ratio ?? 80) / 100;
        const w = 1 - r;
        return [n.id, { loadFactor: r + 3 * w, readRatio: (100 * r) / (r + 3 * w) }];
      })),
    }),
  },
  {
    id: 'db-lose-copy', area: 'Database', name: 'Lose a database copy', appliesTo: ['Database'],
    description: 'One database machine fails. With a single copy, that is the primary.',
    build: (g) => ({ overrides: Object.fromEntries(ofType(g, 'Database').map((n) => [n.id, replicaLoss(g, n.id)])) }),
  },
  {
    id: 'db-slow-queries', area: 'Database', name: 'Slow queries', appliesTo: ['Database'],
    description: 'A missing index or a lock makes every query three times slower.',
    build: (g) => ({ overrides: each(ofType(g, 'Database').map((n) => n.id), { latencyFactor: 3, capacityFactor: 1 / 3 }) }),
  },
  {
    id: 'cache-cold', area: 'Cache', name: 'Cache restarts empty', appliesTo: ['Cache'],
    description: 'Every key misses at once until the cache warms up again.',
    build: (g) => ({
      overrides: Object.fromEntries(ofType(g, 'Cache').map((n) => [n.id, { hitRatio: n.config.request_coalescing ? Number(n.config.hit_ratio ?? 0.8) * 0.6 : 0 }])),
    }),
  },
  {
    id: 'cache-hit-drop', area: 'Cache', name: 'Hit ratio falls to 50%', appliesTo: ['Cache'],
    description: 'Traffic shifts to data that is not cached.',
    build: (g) => ({ overrides: each(ofType(g, 'Cache').map((n) => n.id), { hitRatio: 0.5 }) }),
  },
  {
    id: 'cache-lose-node', area: 'Cache', name: 'Lose a cache node', appliesTo: ['Cache'],
    description: 'With a single node, every request falls through to the store behind it.',
    build: (g) => ({
      overrides: Object.fromEntries(ofType(g, 'Cache').map((n) => [n.id, Number(n.config.replicas ?? 1) > 1 ? { replicasDelta: -1 } : { hitRatio: 0 }])),
    }),
  },
  {
    id: 'queue-slow-consumers', area: 'Queue', name: 'Consumers slow down', appliesTo: ['Worker'],
    description: 'Workers reading the queue run at half speed.',
    build: (g) => ({ overrides: each(ofType(g, 'Worker').map((n) => n.id), { capacityFactor: 0.5, latencyFactor: 2 }) }),
  },
  {
    id: 'compute-slow-dependency', area: 'Compute', name: 'Slow dependency', appliesTo: ['Service', 'Server'],
    description: 'Each request takes twice as long, so each instance serves half as many.',
    build: (g) => ({ overrides: each(ofType(g, 'Service', 'Server').map((n) => n.id), { latencyFactor: 2, capacityFactor: 0.5 }) }),
  },
];

/** Adds retry load on nodes whose callers retry dropped requests. */
function withRetries(graph: Graph, options: SimOptions) {
  const first = simulate(graph, options);
  const overrides = { ...(options.overrides ?? {}) };
  let retryRps = 0;
  for (const m of first.node_metrics) {
    if (m.overflow <= 0) continue;
    const self = graph.nodes.find((n) => n.id === m.component_id);
    const callers = graph.edges.filter((e) => e.target === m.component_id).map((e) => graph.nodes.find((n) => n.id === e.source));
    const retries = Math.max(0, ...[self, ...callers].map((c) => Number(c?.config.retry_limit ?? 0)));
    if (!retries) continue;
    const extra = m.overflow * RETRY_SHARE * Math.min(retries, 3);
    retryRps += extra;
    const o = overrides[m.component_id] ?? {};
    overrides[m.component_id] = { ...o, loadFactor: (o.loadFactor ?? 1) * (1 + extra / Math.max(1, m.incoming_rps)) };
  }
  return { result: retryRps ? simulate(graph, { ...options, overrides }) : first, retryRps };
}

export function runStressTest(graph: Graph, latencyTargetMs: number | null = null): StressReport {
  const base = simulate(graph, { latencyTargetMs });
  const load = base.performance.incoming_rps;

  const ramp: RampPoint[] = RAMP.map((x) => {
    const sim = simulate(graph, { trafficScale: x });
    const r = sim.node_metrics.filter((m) => m.component_type !== 'User');
    const hottest = r.reduce<NodeMetric | null>((a, b) => (!a || b.utilization > a.utilization ? b : a), null);
    return {
      x, rps: Math.round(load * x),
      latency_ms: sim.performance.total_latency,
      error: sim.performance.error_rate,
      hottest: hottest?.component_id ?? null,
      hottest_utilization: hottest?.utilization ?? 0,
      load: Object.fromEntries(r.map((m) => [m.component_id, m.utilization])),
    };
  });

  const present = new Set(graph.nodes.map((n) => n.type));
  const scenarios: ScenarioResult[] = SCENARIOS.map((s) => {
    const head = { id: s.id, area: s.area, name: s.name, description: s.description };
    if (s.appliesTo !== 'any' && !s.appliesTo.some((t) => present.has(t))) {
      return { ...head, pass: true, served: 1, latency_ms: 0, why: [], skipped: `No ${s.appliesTo.join(' or ')} in the design` };
    }
    const built = s.build(graph, base.node_metrics);
    if (typeof built === 'string') return { ...head, pass: true, served: 1, latency_ms: 0, why: [], skipped: built };
    const { result, retryRps } = withRetries(graph, { ...built, latencyTargetMs });
    const served = 1 - result.performance.error_rate;
    const why: string[] = [];
    for (const m of result.node_metrics) {
      if (m.status === 'overloaded' && m.async_only) why.push(`${m.component_id} falls behind; its backlog grows by ${Math.round(m.overflow)} jobs/s.`);
      else if (m.status === 'overloaded') why.push(`${m.component_id} runs at ${Math.round(m.utilization * 100)}% of its capacity.`);
      if (m.status === 'down' && m.incoming_rps > 0) why.push(`${m.component_id} is down and its traffic fails.`);
    }
    if (retryRps > 0) why.push(`Callers retry about ${Math.round(retryRps)} requests/s on top of the real traffic.`);
    const tooSlow = latencyTargetMs != null && result.performance.total_latency > latencyTargetMs;
    if (tooSlow) why.push(`Latency ${Math.round(result.performance.total_latency)} ms misses the ${latencyTargetMs} ms target.`);
    return { ...head, pass: served >= 1 - ERROR_BUDGET && !tooSlow, served: Math.round(served * 1000) / 1000, latency_ms: result.performance.total_latency, why };
  });

  return {
    load_rps: load,
    breaks_at_rps: base.performance.first_failure_rps,
    first_to_give: base.performance.first_failure_node,
    headroom: base.performance.capacity_headroom,
    pass: base.performance.error_rate <= ERROR_BUDGET && (latencyTargetMs == null || base.performance.total_latency <= latencyTargetMs),
    ramp,
    scenarios,
  };
}
