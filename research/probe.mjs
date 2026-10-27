// Sends a small, rate-limited set of crafted graphs to the reference simulator.
// Raw responses go to research/private/probes/ (git-ignored: they contain the reference site's own text);
// research/probes/ gets a numbers-only copy of each /simulate response, which the golden tests replay.
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://www.prismhld.com';
const HERE = import.meta.dirname;
const OUT = path.join(HERE, 'probes');
const RAW = path.join(HERE, 'private', 'probes');
const catalog = JSON.parse(fs.readFileSync(path.join(HERE, 'catalog-extracted.json'), 'utf8')).defaults;
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
const METRIC_KEYS = ['component_id', 'component_type', 'incoming_rps', 'effective_rps', 'effective_capacity', 'overflow', 'utilization', 'latency', 'queue_delay_ms', 'latency_p95_ms', 'latency_p99_ms', 'status', 'replicas'];
const PERF_KEYS = ['incoming_rps', 'throughput', 'error_rate', 'total_latency', 'system_status', 'bottleneck_node_id', 'first_failure_node', 'first_failure_rps', 'capacity_headroom', 'async_backlog_rps'];

/** Keeps only the numbers the golden tests compare. */
function trim(json) {
  if (!Array.isArray(json.node_metrics)) return null;
  return {
    node_metrics: json.node_metrics.map((m) => pick(m, METRIC_KEYS)),
    performance: pick(json.performance ?? {}, PERF_KEYS),
    score: pick(json.score ?? {}, ['total', 'grade', 'arch_pts', 'sim_pts']),
  };
}

function node(id, type, overrides = {}, x = 0) {
  const def = catalog[type];
  const basic = { ...def.basic }, advanced = { ...def.advanced };
  for (const [k, v] of Object.entries(overrides)) (k in basic ? basic : advanced)[k] = v;
  return { id, type, x, y: 0, position: { x, y: 0 }, config: { ...basic, ...advanced, name: def.name || type, description: '', basic, advanced } };
}
const e = (source, target, connection_type = 'sync') => ({ source, target, connection_type, direction: 'single' });

function baseline({ users = 1000, rpu = 1, svc = {}, db = {}, lb = {} } = {}) {
  return {
    nodes: [node('User-1', 'User', { number_of_users: users, requests_per_user: rpu }), node('LoadBalancer-2', 'LoadBalancer', lb, 200), node('Service-3', 'Service', svc, 400), node('Database-4', 'Database', db, 600)],
    edges: [e('User-1', 'LoadBalancer-2'), e('LoadBalancer-2', 'Service-3'), e('Service-3', 'Database-4')],
  };
}
function withCache(hit, opts = {}) {
  const g = baseline(opts);
  g.nodes.push(node('Cache-5', 'Cache', { hit_ratio: hit }, 500));
  g.edges = [e('User-1', 'LoadBalancer-2'), e('LoadBalancer-2', 'Service-3'), e('Service-3', 'Cache-5'), e('Cache-5', 'Database-4')];
  return g;
}
function withQueue(opts = {}) {
  const g = baseline(opts);
  g.nodes.push(node('Queue-5', 'Queue', {}, 500), node('Worker-6', 'Worker', {}, 700));
  g.edges.push(e('Service-3', 'Queue-5', 'async'), e('Queue-5', 'Worker-6', 'async'), e('Worker-6', 'Database-4'));
  return g;
}

const probes = {
  'sim-01-baseline-100': baseline({ users: 100 }),
  'sim-02-baseline-500': baseline({ users: 500 }),
  'sim-03-baseline-1000': baseline({ users: 1000 }),
  'sim-04-baseline-2000': baseline({ users: 2000 }),
  'sim-05-baseline-5000': baseline({ users: 5000 }),
  'sim-06-svc-replicas3-2000': baseline({ users: 2000, svc: { replicas: 3 } }),
  'sim-07-db-replicas3-2000': baseline({ users: 2000, svc: { replicas: 3 }, db: { replicas: 3 } }),
  'sim-08-db-shards2-5000': baseline({ users: 5000, svc: { replicas: 6 }, db: { replicas: 3, shards: 2 } }),
  'sim-09-cache50-2000': withCache(0.5, { users: 2000, svc: { replicas: 3 } }),
  'sim-10-cache90-2000': withCache(0.9, { users: 2000, svc: { replicas: 3 } }),
  'sim-11-queue-1000': withQueue({ users: 1000 }),
  'sim-12-read50-1000': baseline({ users: 1000, db: { read_ratio: 50 } }),
  'sim-13-svc-latency-1500': baseline({ users: 1500, svc: { replicas: 2 } }),
  'sim-14-orphan': (() => { const g = baseline({ users: 100 }); g.nodes.push(node('Cache-9', 'Cache', {}, 800)); return g; })(),
};
const stress = {
  'stress-01-baseline': { graph: baseline({ users: 1000, svc: { replicas: 2 } }), focus: [{ area: 'Database', disabled: [] }] },
  'stress-02-cache': { graph: withCache(0.8, { users: 1000, svc: { replicas: 2 } }), focus: [{ area: 'Cache', disabled: [] }, { area: 'Database', disabled: [] }] },
  'stress-03-queue': { graph: withQueue({ users: 1000, svc: { replicas: 2 } }), focus: [{ area: 'Queue', disabled: [] }] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(url, body, name) {
  const res = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 2000) }; }
  fs.writeFileSync(path.join(RAW, name + '.json'), JSON.stringify({ url, status: res.status, request: body, response: json }, null, 2));
  const numbers = trim(json);
  if (numbers) fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify({ url, status: res.status, request: body, response: numbers }, null, 2) + '\n');
  console.log(name, res.status, Object.keys(json).slice(0, 25).join(','));
}

const only = process.argv[2];
for (const [name, graph] of Object.entries(probes)) {
  if (only && !name.startsWith(only)) continue;
  await post('/simulate', { graph, mode: 'practice', traffic_profile: null, hints_used: 0 }, name);
  await sleep(3000);
}
for (const [name, p] of Object.entries(stress)) {
  if (only && !name.startsWith(only)) continue;
  await post('/api/stress-test', { graph: p.graph, focus: p.focus, nfrs: [], traffic_profile: { requests_per_second: 1000 } }, name);
  await sleep(3000);
}
