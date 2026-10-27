export type ComponentType =
  | 'User' | 'CDN' | 'LoadBalancer' | 'APIGateway' | 'ReverseProxy' | 'RateLimiter'
  | 'Server' | 'Service' | 'WebSocketServer' | 'Cache' | 'Database' | 'SearchIndex'
  | 'BlobStorage' | 'Queue' | 'Worker' | 'ThirdPartyAPI';

export type ConfigValue = number | string | boolean;
export type NodeConfig = Record<string, ConfigValue>;

export interface GraphNode {
  id: string;
  type: ComponentType;
  config: NodeConfig;
  position: { x: number; y: number };
}

export type ConnectionType = 'sync' | 'async';

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  connection_type: ConnectionType;
  /** Relative share of the source's outgoing traffic; siblings default to 1 each (an even split). */
  weight?: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type NodeStatus = 'healthy' | 'overloaded' | 'down' | 'idle';
export type SystemStatus = 'healthy' | 'degrading' | 'failing' | 'invalid';

export interface NodeMetric {
  component_id: string;
  component_type: ComponentType;
  incoming_rps: number;
  effective_rps: number;
  effective_capacity: number;
  overflow: number;
  utilization: number;
  base_latency_ms: number;
  queue_delay_ms: number;
  latency: number;
  latency_p95_ms: number;
  latency_p99_ms: number;
  replicas: number;
  status: NodeStatus;
  /** Only reached through async edges, so overload means backlog rather than user errors. */
  async_only: boolean;
}

export interface Performance {
  incoming_rps: number;
  throughput: number;
  error_rate: number;
  /** Work dropped by consumers behind async hops: it piles up instead of failing users. */
  async_backlog_rps: number;
  total_latency: number;
  system_status: SystemStatus;
  bottleneck_node_id: string | null;
  first_failure_node: string | null;
  first_failure_rps: number | null;
  capacity_headroom: number | null;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
  nodeIds?: string[];
}

export interface ScoreBreakdown {
  arch_pts: number;
  arch_max: number;
  sim_pts: number;
  sim_max: number;
  contributions: { label: string; points: number }[];
  penalties: { label: string; points: number }[];
  total: number;
  total_max: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

export interface SimResult {
  valid: boolean;
  structural_errors: Finding[];
  node_metrics: NodeMetric[];
  performance: Performance;
  findings: Finding[];
  score: ScoreBreakdown;
}

/** Per-node tweaks a stress scenario applies on top of the user's design. */
export interface NodeOverride {
  down?: boolean;
  capacityFactor?: number;
  latencyFactor?: number;
  loadFactor?: number;
  hitRatio?: number;
  replicasDelta?: number;
  readRatio?: number;
}

export interface SimOptions {
  overrides?: Record<string, NodeOverride>;
  /** Multiplies every User node's traffic. */
  trafficScale?: number;
  latencyTargetMs?: number | null;
}
