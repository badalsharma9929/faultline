import type { ComponentType, NodeConfig } from './types';

export type ParamSpec =
  | { key: string; label: string; kind: 'number'; unit?: string; min?: number; max?: number; step?: number; hint?: string }
  | { key: string; label: string; kind: 'toggle'; hint?: string }
  | { key: string; label: string; kind: 'select'; options: string[]; hint?: string };

export interface ComponentSpec {
  type: ComponentType;
  label: string;
  group: 'Clients' | 'Edge' | 'Compute' | 'Data' | 'Async' | 'External';
  /** Requests per second one instance handles. */
  capacity: number;
  /** Service time in ms with no queueing. */
  baseLatency: number;
  defaults: NodeConfig;
  params: ParamSpec[];
  /** How traffic leaving this node relates to traffic it served. */
  passThrough: 'all' | 'cache-miss' | 'none';
  /** Parallel servers per instance for the queueing model. */
  serversPerInstance: number;
  /** Short monospace tag shown on nodes and in the palette. */
  code: string;
}

const replicas = (label = 'Instances', max = 100): ParamSpec => ({ key: 'replicas', label, kind: 'number', min: 1, max });
const capacity: ParamSpec = { key: 'capacity', label: 'Capacity', kind: 'number', unit: 'rps/instance', min: 1 };
const latency: ParamSpec = { key: 'base_latency', label: 'Base latency', kind: 'number', unit: 'ms', min: 0 };

function spec(s: Omit<ComponentSpec, 'defaults' | 'passThrough' | 'serversPerInstance'> & Partial<ComponentSpec> & { extra?: NodeConfig }): ComponentSpec {
  const { extra, ...rest } = s;
  return {
    passThrough: 'all',
    serversPerInstance: 40,
    ...rest,
    defaults: { capacity: s.capacity, base_latency: s.baseLatency, replicas: 1, ...extra },
  };
}

export const CATALOG: Record<ComponentType, ComponentSpec> = {
  User: spec({
    type: 'User', label: 'Users', group: 'Clients', capacity: 0, baseLatency: 0, code: 'USR', passThrough: 'all',
    extra: { number_of_users: 1000, requests_per_user: 1 },
    params: [
      { key: 'number_of_users', label: 'Concurrent users', kind: 'number', min: 0 },
      { key: 'requests_per_user', label: 'Requests / user / s', kind: 'number', min: 0, step: 0.1 },
    ],
  }),
  CDN: spec({
    type: 'CDN', label: 'CDN', group: 'Edge', capacity: 100000, baseLatency: 4, code: 'CDN', passThrough: 'cache-miss',
    extra: { hit_ratio: 0.9 },
    params: [capacity, latency, { key: 'hit_ratio', label: 'Edge hit ratio', kind: 'number', min: 0, max: 1, step: 0.05, hint: 'Share of requests answered at the edge.' }],
  }),
  LoadBalancer: spec({
    type: 'LoadBalancer', label: 'Load Balancer', group: 'Edge', capacity: 50000, baseLatency: 20, code: 'LB',
    extra: { replicas: 2 },
    params: [capacity, latency, replicas()],
  }),
  APIGateway: spec({
    type: 'APIGateway', label: 'API Gateway', group: 'Edge', capacity: 20000, baseLatency: 8, code: 'GW',
    extra: { auth_enabled: false },
    params: [capacity, latency, replicas(), { key: 'auth_enabled', label: 'Authentication', kind: 'toggle' }],
  }),
  ReverseProxy: spec({
    type: 'ReverseProxy', label: 'Reverse Proxy', group: 'Edge', capacity: 30000, baseLatency: 3, code: 'RP',
    params: [capacity, latency, replicas()],
  }),
  RateLimiter: spec({
    type: 'RateLimiter', label: 'Rate Limiter', group: 'Edge', capacity: 50000, baseLatency: 8, code: 'RL',
    params: [capacity, latency, replicas()],
  }),
  Server: spec({
    type: 'Server', label: 'App Server', group: 'Compute', capacity: 1000, baseLatency: 50, code: 'APP', serversPerInstance: 12,
    extra: { cpu_cores: 2, autoscaling: false, autoscale_min: 1, autoscale_max: 10 },
    params: [capacity, latency, replicas('Replicas', 1000),
      { key: 'cpu_cores', label: 'CPU cores', kind: 'number', min: 1, max: 128, hint: 'Capacity is quoted at 2 cores.' },
      { key: 'autoscaling', label: 'Autoscaling', kind: 'toggle', hint: 'Keeps each copy near 70% busy between min and max.' },
      { key: 'autoscale_min', label: 'Min instances', kind: 'number', min: 1 },
      { key: 'autoscale_max', label: 'Max instances', kind: 'number', min: 1 }],
  }),
  Service: spec({
    type: 'Service', label: 'Service', group: 'Compute', capacity: 1000, baseLatency: 22, code: 'SVC', serversPerInstance: 12,
    extra: { retry_limit: 2, auth_enabled: false },
    params: [capacity, latency, replicas('Replicas', 1000),
      { key: 'retry_limit', label: 'Retries on failure', kind: 'number', min: 0, max: 5, hint: 'Retries add load when a dependency is overloaded.' },
      { key: 'auth_enabled', label: 'Authentication', kind: 'toggle' }],
  }),
  WebSocketServer: spec({
    type: 'WebSocketServer', label: 'WebSocket Server', group: 'Compute', capacity: 10000, baseLatency: 5, code: 'WS',
    params: [capacity, latency, replicas()],
  }),
  Cache: spec({
    type: 'Cache', label: 'Cache', group: 'Data', capacity: 50000, baseLatency: 5, code: 'KV', passThrough: 'cache-miss',
    extra: { hit_ratio: 0.8, request_coalescing: false },
    params: [capacity, latency, replicas('Nodes', 50),
      { key: 'hit_ratio', label: 'Hit ratio', kind: 'number', min: 0, max: 1, step: 0.05, hint: 'Only misses reach the next hop.' },
      { key: 'request_coalescing', label: 'Request coalescing', kind: 'toggle', hint: 'Softens cold restarts and expiry stampedes.' }],
  }),
  Database: spec({
    type: 'Database', label: 'Database', group: 'Data', capacity: 2000, baseLatency: 80, code: 'DB',
    extra: { read_ratio: 80, shards: 1, backups: false },
    params: [capacity, latency, replicas('Copies (1 primary + replicas)', 20),
      { key: 'read_ratio', label: 'Read share', kind: 'number', unit: '%', min: 0, max: 100, hint: 'Reads spread over every copy; writes all hit the primary.' },
      { key: 'shards', label: 'Shards', kind: 'number', min: 1, max: 64 },
      { key: 'backups', label: 'Backups', kind: 'toggle' }],
  }),
  SearchIndex: spec({
    type: 'SearchIndex', label: 'Search Index', group: 'Data', capacity: 5000, baseLatency: 12, code: 'IDX',
    extra: { shards: 1 },
    params: [capacity, latency, replicas('Replicas', 20), { key: 'shards', label: 'Shards', kind: 'number', min: 1, max: 64 }],
  }),
  BlobStorage: spec({
    type: 'BlobStorage', label: 'Blob Storage', group: 'Data', capacity: 5000, baseLatency: 30, code: 'OBJ',
    params: [capacity, latency],
  }),
  Queue: spec({
    type: 'Queue', label: 'Queue', group: 'Async', capacity: 20000, baseLatency: 30, code: 'Q',
    extra: { dlq_enabled: true },
    params: [capacity, latency, { key: 'dlq_enabled', label: 'Dead-letter queue', kind: 'toggle' }],
  }),
  Worker: spec({
    type: 'Worker', label: 'Worker', group: 'Async', capacity: 500, baseLatency: 25, code: 'WRK', serversPerInstance: 4,
    extra: { concurrency: 4 },
    params: [capacity, latency, replicas('Replicas', 200),
      { key: 'concurrency', label: 'Concurrency', kind: 'number', min: 1, max: 64, hint: 'Capacity is quoted at 4.' }],
  }),
  ThirdPartyAPI: spec({
    type: 'ThirdPartyAPI', label: 'Third-party API', group: 'External', capacity: 100, baseLatency: 200, code: 'EXT', passThrough: 'none',
    params: [capacity, latency],
  }),
};

export const PALETTE_GROUPS: ComponentSpec['group'][] = ['Clients', 'Edge', 'Compute', 'Data', 'Async', 'External'];

export const COMPUTE_TYPES: ComponentType[] = ['Server', 'Service', 'WebSocketServer'];
export const STORAGE_TYPES: ComponentType[] = ['Database', 'SearchIndex', 'BlobStorage'];

export function defaultConfig(type: ComponentType): NodeConfig {
  return { ...CATALOG[type].defaults, name: CATALOG[type].label };
}

export const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
