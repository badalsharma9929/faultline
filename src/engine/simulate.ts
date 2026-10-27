import { CATALOG, num } from './catalog';
import { analyzeDesign } from './findings';
import { scoreDesign } from './score';
import { edgeShares, orderGraph } from './graph';
import { validateGraph } from './validate';
import type {
  Graph, GraphNode, NodeMetric, NodeOverride, Performance, SimOptions, SimResult, SystemStatus,
} from './types';

/** Utilisation at which a node starts to count as the bottleneck. */
export const HOT_UTILIZATION = 0.75;
const QUEUE_CLAMP = 0.99;
const OVERLOAD_DELAY_MULTIPLIER = 10;
const PERCENTILE_U_CLAMP = 1.5;

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** Erlang-C probability of waiting, via the numerically stable Erlang-B recursion. */
export function erlangC(servers: number, offered: number): number {
  if (offered <= 0) return 0;
  if (offered >= servers) return 1;
  let b = 1;
  for (let k = 1; k <= servers; k++) b = (offered * b) / (k + offered * b);
  return (servers * b) / (servers - offered * (1 - b));
}

/** Mean M/M/c queueing delay in ms for a node with total capacity `capRps` spread over `servers`. */
export function queueDelayMs(capRps: number, servers: number, utilization: number, baseLatency: number): number {
  if (utilization <= 0 || capRps <= 0) return 0;
  if (utilization > 1) return OVERLOAD_DELAY_MULTIPLIER * baseLatency;
  const u = Math.min(utilization, QUEUE_CLAMP);
  const c = Math.max(1, Math.round(servers));
  return (erlangC(c, u * c) / (capRps * (1 - u))) * 1000;
}

export function percentiles(latency: number, utilization: number) {
  const u = Math.min(utilization, PERCENTILE_U_CLAMP);
  return { p95: latency * (1 + 0.9 * u * u), p99: latency * (1 + 1.8 * u * u) };
}

interface NodeModel {
  node: GraphNode;
  override: NodeOverride;
  replicas: number;
  capacity: number;
  servers: number;
  baseLatency: number;
  loadFactor: number;
  passRatio: number;
}

function modelNode(node: GraphNode, override: NodeOverride, demandRps: number): NodeModel {
  const spec = CATALOG[node.type];
  const cfg = node.config;
  const perInstance = num(cfg.capacity, spec.capacity) * (override.capacityFactor ?? 1);
  let replicas = Math.max(1, Math.round(num(cfg.replicas, 1)));

  if (node.type === 'Server' && cfg.autoscaling) {
    const perCopy = perInstance * (num(cfg.cpu_cores, 2) / 2);
    const wanted = Math.ceil(demandRps / Math.max(1, perCopy * 0.7));
    replicas = Math.min(num(cfg.autoscale_max, 10), Math.max(num(cfg.autoscale_min, 1), wanted));
  }
  replicas = Math.max(0, replicas + (override.replicasDelta ?? 0));

  let capacity = perInstance * replicas;
  let servers = spec.serversPerInstance * replicas;
  let loadFactor = override.loadFactor ?? 1;

  if (node.type === 'Server') capacity *= num(cfg.cpu_cores, 2) / 2;
  if (node.type === 'Worker') {
    const concurrency = num(cfg.concurrency, 4);
    capacity *= concurrency / 4;
    servers = concurrency * replicas;
  }
  if (node.type === 'Database' && replicas > 0) {
    const reads = (override.readRatio ?? num(cfg.read_ratio, 80)) / 100;
    capacity = (perInstance * Math.max(1, num(cfg.shards, 1))) / (1 - reads + reads / replicas);
    servers = spec.serversPerInstance * (capacity / perInstance);
  }
  if (node.type === 'SearchIndex') capacity *= Math.max(1, num(cfg.shards, 1));
  if (override.down || replicas === 0) capacity = 0;

  let passRatio = 1;
  if (spec.passThrough === 'cache-miss') {
    const hit = override.hitRatio ?? num(cfg.hit_ratio, 0.8);
    passRatio = 1 - Math.min(1, Math.max(0, hit));
  } else if (spec.passThrough === 'none') {
    passRatio = 0;
  }

  return {
    node, override, replicas, capacity, servers, loadFactor, passRatio,
    baseLatency: num(cfg.base_latency, spec.baseLatency) * (override.latencyFactor ?? 1),
  };
}

export function simulate(graph: Graph, options: SimOptions = {}): SimResult {
  const structural = validateGraph(graph);
  const { order, out, byId, entries, reachable } = orderGraph(graph);
  const share = edgeShares(out);
  // 'split': each request takes one branch, by weight. 'all': every request calls every branch.
  const callsAll = (id: string) => byId.get(id)!.config.fanout === 'all';
  const fraction = (e: Graph['edges'][number]) => (callsAll(e.source) ? 1 : share.get(e)!);
  const overrides = options.overrides ?? {};
  const scale = options.trafficScale ?? 1;

  const entryRps = new Map<string, number>();
  for (const u of entries) {
    entryRps.set(u.id, num(u.config.number_of_users) * num(u.config.requests_per_user, 1) * scale);
  }
  const incomingTotal = [...entryRps.values()].reduce((a, b) => a + b, 0);

  // Pass 1: uncapped demand, used for headroom (where would each node break?).
  const demand = new Map<string, number>();
  const models = new Map<string, NodeModel>();
  for (const id of order) {
    const node = byId.get(id)!;
    const d = node.type === 'User' ? entryRps.get(id)! : demand.get(id) ?? 0;
    demand.set(id, d);
    const m = modelNode(node, overrides[id] ?? {}, d * (overrides[id]?.loadFactor ?? 1));
    models.set(id, m);
    const children = out.get(id)!;
    for (const e of children) demand.set(e.target, (demand.get(e.target) ?? 0) + d * m.passRatio * fraction(e));
  }

  // Pass 2: real flow, where each node can only forward what it served.
  const incoming = new Map<string, number>();
  const metrics = new Map<string, NodeMetric>();
  // A node is async-only when every path into it crosses an async edge.
  const asyncOnly = new Map<string, boolean>();
  for (const id of order) {
    if (byId.get(id)!.type === 'User') { asyncOnly.set(id, false); continue; }
    const into = graph.edges.filter((e) => e.target === id && reachable.has(e.source) && out.get(e.source)!.includes(e));
    asyncOnly.set(id, into.length > 0 && into.every((e) => e.connection_type === 'async' || asyncOnly.get(e.source)));
  }
  for (const id of order) {
    const node = byId.get(id)!;
    const m = models.get(id)!;
    const inRps = node.type === 'User' ? entryRps.get(id)! : incoming.get(id) ?? 0;
    let served = inRps;
    let utilization = 0;
    let delay = 0;
    let status: NodeMetric['status'] = 'healthy';
    if (node.type !== 'User') {
      const load = inRps * m.loadFactor;
      served = m.capacity > 0 ? Math.min(inRps, m.capacity / m.loadFactor) : 0;
      utilization = m.capacity > 0 ? load / m.capacity : inRps > 0 ? Infinity : 0;
      delay = queueDelayMs(m.capacity, m.servers, utilization, m.baseLatency);
      status = m.capacity === 0 ? 'down' : utilization > 1 ? 'overloaded' : inRps === 0 ? 'idle' : 'healthy';
    }
    const latency = node.type === 'User' ? 0 : m.baseLatency + delay;
    const p = percentiles(latency, Number.isFinite(utilization) ? utilization : PERCENTILE_U_CLAMP);
    metrics.set(id, {
      component_id: id,
      component_type: node.type,
      incoming_rps: round(inRps),
      effective_rps: round(served),
      effective_capacity: round(node.type === 'User' ? inRps : m.capacity, 1),
      overflow: round(inRps - served),
      utilization: Number.isFinite(utilization) ? round(utilization) : 999,
      base_latency_ms: m.baseLatency,
      queue_delay_ms: round(delay),
      latency: round(latency),
      latency_p95_ms: round(p.p95),
      latency_p99_ms: round(p.p99),
      replicas: m.replicas,
      status,
      async_only: asyncOnly.get(id) ?? false,
    });
    const children = out.get(id)!;
    for (const e of children) incoming.set(e.target, (incoming.get(e.target) ?? 0) + served * m.passRatio * fraction(e));
  }

  // Expected user-facing latency and success share, walking the sync paths.
  const latencyMemo = new Map<string, number>();
  const successMemo = new Map<string, number>();
  const pathLatency = (id: string): number => {
    if (latencyMemo.has(id)) return latencyMemo.get(id)!;
    const m = models.get(id)!;
    const children = out.get(id)!;
    const sync = children.filter((e) => e.connection_type !== 'async');
    // Calls run in parallel, so a call-all node waits for its slowest sync branch.
    const below = callsAll(id)
      ? Math.max(0, ...sync.map((e) => pathLatency(e.target)))
      : sync.reduce((acc, e) => acc + share.get(e)! * pathLatency(e.target), 0);
    const v = metrics.get(id)!.latency + m.passRatio * below;
    latencyMemo.set(id, v);
    return v;
  };
  const success = (id: string): number => {
    if (successMemo.has(id)) return successMemo.get(id)!;
    const m = metrics.get(id)!;
    const model = models.get(id)!;
    const own = m.incoming_rps > 0 ? m.effective_rps / m.incoming_rps : model.capacity > 0 || m.component_type === 'User' ? 1 : 0;
    const children = out.get(id)!;
    // A call-all request succeeds only if every sync branch does; async hand-offs count as accepted.
    const below = callsAll(id)
      ? children.reduce((acc, e) => acc * (e.connection_type === 'async' ? 1 : success(e.target)), 1)
      : children.length
        ? children.reduce((acc, e) => acc + share.get(e)! * (e.connection_type === 'async' ? 1 : success(e.target)), 0)
        : 1;
    const v = own * (1 - model.passRatio + model.passRatio * below);
    successMemo.set(id, v);
    return v;
  };

  let totalLatency = 0;
  let successShare = 1;
  if (incomingTotal > 0) {
    totalLatency = entries.reduce((acc, u) => acc + pathLatency(u.id) * entryRps.get(u.id)!, 0) / incomingTotal;
    successShare = entries.reduce((acc, u) => acc + success(u.id) * entryRps.get(u.id)!, 0) / incomingTotal;
  }

  const working = [...metrics.values()].filter((m) => m.component_type !== 'User' && reachable.has(m.component_id));
  const hottest = working.reduce<NodeMetric | null>((a, b) => (!a || b.utilization > a.utilization ? b : a), null);
  const errorRate = round(Math.max(0, 1 - successShare));

  let firstFailure: { id: string; rps: number } | null = null;
  if (incomingTotal > 0) {
    for (const m of working) {
      const model = models.get(m.component_id)!;
      const gain = ((demand.get(m.component_id) ?? 0) * model.loadFactor) / incomingTotal;
      if (gain <= 0) continue;
      const rps = model.capacity / gain;
      if (!firstFailure || rps < firstFailure.rps) firstFailure = { id: m.component_id, rps };
    }
  }

  let status: SystemStatus = 'healthy';
  if (structural.some((f) => f.severity === 'error')) status = 'invalid';
  else if (errorRate > 0) status = 'failing';
  else if (hottest && hottest.utilization >= HOT_UTILIZATION) status = 'degrading';

  const performance: Performance = {
    incoming_rps: round(incomingTotal),
    throughput: round(incomingTotal * successShare),
    error_rate: errorRate,
    async_backlog_rps: round(working.filter((m) => m.async_only).reduce((a, m) => a + m.overflow, 0)),
    total_latency: round(totalLatency),
    system_status: status,
    bottleneck_node_id: hottest && hottest.utilization >= HOT_UTILIZATION ? hottest.component_id : null,
    first_failure_node: firstFailure?.id ?? null,
    first_failure_rps: firstFailure ? round(firstFailure.rps, 1) : null,
    capacity_headroom: firstFailure && incomingTotal > 0 ? round(firstFailure.rps / incomingTotal) : null,
  };

  const nodeMetrics = graph.nodes.map((n) => metrics.get(n.id)).filter((m): m is NodeMetric => !!m);
  const findings = analyzeDesign(graph, nodeMetrics, performance);
  const score = scoreDesign(graph, performance, nodeMetrics, [...structural, ...findings], options.latencyTargetMs ?? null);

  return {
    valid: !structural.some((f) => f.severity === 'error'),
    structural_errors: structural,
    node_metrics: nodeMetrics,
    performance,
    findings,
    score,
  };
}
