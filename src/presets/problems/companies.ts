import { CATALOG } from '../../engine/catalog';
import { simulate } from '../../engine/simulate';
import type { ComponentType, Graph } from '../../engine/types';
import research from '../data/companies.json';
import { problem, type NodeSpec, type Preset } from '../dsl';

interface Researched {
  id: string;
  company: string;
  product: string;
  summary: string;
  scale: { peak_rps: number; notes: string };
  latency_target_ms: number;
  components: { id: string; type: ComponentType; name: string; notes: string }[];
  edges: { source: string; target: string; type: 'sync' | 'async' }[];
  cache_hit_ratio: number;
  key_ideas: string[];
  sources: { title: string; url: string }[];
}

/** What each modelled request path has to do, in our words. */
const FUNCTIONAL: Record<string, string[]> = {
  uber: ['Ingest driver locations every few seconds', 'Match a rider to the nearest available driver by ETA', 'Push trip updates to both apps in real time'],
  netflix: ['Authorise and license a title for playback', 'Steer the device to the closest healthy edge cache', 'Stream video segments from the edge, filling from origin on a miss'],
  whatsapp: ['Deliver a message to an online recipient', 'Hold messages for offline phones and wake them with a push', 'Upload media separately and send only a link'],
  instagram: ['Build a home feed from precomputed entries', 'Serve photos from a CDN', 'Fan new posts out to followers in the background'],
  youtube: ['Build the watch page and player config', 'Look up video metadata across MySQL shards', 'Serve video bytes from an edge cache near the viewer'],
  twitter: ['Read a precomputed home timeline', 'Hydrate tweet IDs into tweets and authors', 'Rebuild a timeline from disk on a cache miss'],
  'amazon-checkout': ['Show the cart and accept every add-to-cart write', 'Place an order and record it durably', 'Hand fulfilment off without making the shopper wait'],
  airbnb: ['Embed the search query', 'Retrieve and rank candidate homes across index shards', 'Drop results whose price or availability changed'],
  spotify: ['Resolve a track to playable audio files', 'Stream audio from a CDN', 'Log play events for royalties and recommendations'],
  discord: ['Persist a message to the channel history', 'Publish it to every connected member of the server', 'Push it down each member\'s WebSocket'],
  slack: ['Save a channel message', 'Route it to the channel\'s owning server', 'Deliver it to every subscribed client within half a second'],
  stripe: ['Accept a charge request exactly once, even on retries', 'Authorise the payment with card networks', 'Stream every state change to downstream systems'],
};

/** Figures the cited sources give that differ from the generic component defaults. */
const SOURCED_OVERRIDES: Record<string, Record<string, Record<string, number>>> = {
  // "How Discord Stores Trillions of Messages": ScyllaDB insert p99 of about 5 ms.
  discord: { scylla: { base_latency: 10 } },
};

/** Traffic mix on fan-outs where requests take different branches (relative weights, keyed by researched ids). */
const EDGE_WEIGHTS: Record<string, Record<string, number>> = {
  // ~1M driver location writes/s against a few thousand ride requests/s (Uber QCon 2015 figures).
  uber: { 'api-gateway>supply-svc': 99, 'api-gateway>demand-svc': 1 },
  // Image fetches far outnumber feed API calls.
  instagram: { 'user>cdn': 70, 'user>lb': 30 },
  // Most traffic is text messages; media uploads are a minority (estimate).
  whatsapp: { 'phone>edge-lb': 90, 'phone>media-server': 10 },
  // Many cart views per placed order (estimate).
  'amazon-checkout': { 'renderer>cart-svc': 80, 'renderer>order-svc': 20 },
};

/** Nodes (researched ids) where every request calls all outgoing connections, per the cited write-ups. */
const CALL_ALL: Record<string, string[]> = {
  uber: ['disco'],                                       // index lookup, ETA ranking, push hand-off
  netflix: ['viewer', 'playback-svc', 'open-connect'],   // control plane then stream; entitlement + steering
  whatsapp: ['chat-node'],                               // session lookup and routing
  youtube: ['viewer', 'watch-frontend'],                 // page then video; metadata + thumbnails
  twitter: ['timeline-svc'],                             // IDs from Redis, then tweets and authors
  'amazon-checkout': ['order-svc'],                      // record order and queue fulfilment
  airbnb: ['search-root', 'search-leaf'],                // query embedding + leaves; index + availability
  spotify: ['listener', 'access-point'],                 // resolve then stream; metadata, file, play event
  discord: ['api'],                                      // persist and publish
  slack: ['webapp'],                                     // persist, route, queue jobs
  stripe: ['payments', 'docdb-proxy'],                   // store + authorise; shard map + query
};

/**
 * Latency targets the research marked as estimates and the modelled path can't meet with generic
 * component latencies. Discord: the Python API's generic 50 ms plus the slower of persist/publish lands at ~102 ms.
 */
const LATENCY_TARGET_OVERRIDES: Record<string, number> = { discord: 120 };

const TARGET_UTILIZATION = 0.55;
const HOT = 0.65;
const hasReplicas = (t: ComponentType) => CATALOG[t].params.some((p) => p.key === 'replicas');

/**
 * Researched replica counts describe real fleets, not Faultline's per-instance capacities,
 * so size each node with the engine until nothing runs hotter than ~55% at the stated peak.
 */
function autosize(preset: Preset): Preset {
  const nodes = preset.reference.nodes.map((n) => ({ ...n, config: { ...n.config } }));
  const graph = (): Graph => ({
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, config: { ...CATALOG[n.type].defaults, ...n.config }, position: { x: n.x, y: n.y } })),
    edges: preset.reference.edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target, connection_type: e.type ?? 'sync', weight: e.weight })),
  });
  for (let pass = 0; pass < 40; pass++) {
    const hot = simulate(graph()).node_metrics.filter((m) => m.component_type !== 'User' && m.utilization >= HOT);
    if (!hot.length) break;
    for (const m of hot) {
      const n = nodes.find((x) => x.id === m.component_id)!;
      const grow = (v: unknown, fallback: number) => Math.ceil(Number(v ?? fallback) * Math.min(m.utilization, 50) / TARGET_UTILIZATION);
      if (n.type === 'Database') n.config.shards = grow(n.config.shards, 1);
      else if (hasReplicas(n.type)) n.config.replicas = grow(n.config.replicas, 1);
      else n.config.capacity = grow(n.config.capacity, CATALOG[n.type].capacity);
    }
  }
  return { ...preset, reference: { ...preset.reference, nodes } };
}

function fromResearch(r: Researched): Preset {
  const user = r.components.find((c) => c.type === 'User')!.id;
  const rename = (id: string) => (id === user ? 'users' : id);
  const nodes: NodeSpec[] = r.components
    .filter((c) => c.type !== 'User')
    .map((c) => {
      const config: Record<string, string | number | boolean> = { name: c.name };
      if (c.type === 'Cache' || c.type === 'CDN') config.hit_ratio = r.cache_hit_ratio || 0.8;
      if (c.type === 'Database') Object.assign(config, { replicas: 3, backups: true });
      if (c.type === 'ThirdPartyAPI') config.capacity = r.scale.peak_rps;
      Object.assign(config, SOURCED_OVERRIDES[r.id]?.[c.id]);
      if (CALL_ALL[r.id]?.includes(c.id)) config.fanout = 'all';
      return [c.id, c.type, config];
    });
  const weight = (e: Researched['edges'][number]) => {
    const w = EDGE_WEIGHTS[r.id]?.[`${e.source}>${e.target}`];
    return w === undefined ? '' : `@${w}`;
  };
  const flow = r.edges.map((e) => `${rename(e.source)}${e.type === 'async' ? '~>' : '>'}${rename(e.target)}${weight(e)}`).join(', ');
  const preset = problem({
    id: `arch-${r.id}`,
    name: r.company,
    category: 'Real-world architectures',
    difficulty: 'Advanced',
    statement: r.summary,
    functional: FUNCTIONAL[r.id] ?? [r.product],
    nonFunctional: [`${r.scale.peak_rps.toLocaleString('en-US')} requests/s at peak on this path`, `Latency target ${LATENCY_TARGET_OVERRIDES[r.id] ?? r.latency_target_ms} ms`, 'Instance counts sized by Faultline to run this load at about 55% busy'],
    rps: r.scale.peak_rps,
    latencyTargetMs: LATENCY_TARGET_OVERRIDES[r.id] ?? r.latency_target_ms,
    nodes,
    flow,
    notes: r.key_ideas,
    company: { name: r.company, product: r.product, scaleNotes: r.scale.notes, sources: r.sources },
  });
  // The Users node is created by problem(), so its fan-out mode is set here.
  if (CALL_ALL[r.id]?.includes(user)) {
    const users = preset.reference.nodes.find((n) => n.id === 'users')!;
    users.config = { ...users.config, fanout: 'all' };
  }
  return autosize(preset);
}

export const COMPANIES: Preset[] = (research as Researched[]).map(fromResearch);
