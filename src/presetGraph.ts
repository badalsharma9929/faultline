import type { Edge, Node } from '@xyflow/react';
import { defaultConfig } from './engine/catalog';
import type { ComponentType, ConnectionType, Graph, NodeConfig } from './engine/types';
import type { Preset } from './presets';

export type ComponentNodeData = { kind: ComponentType; config: NodeConfig };
export type FlowNode = Node<ComponentNodeData, 'component'>;
export type FlowEdge = Edge<{ connection_type: ConnectionType; weight?: number }>;
export type Mode = 'practice' | 'learn';

export function toGraph(nodes: FlowNode[], edges: FlowEdge[]): Graph {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.data.kind, config: n.data.config, position: n.position })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, connection_type: e.data?.connection_type ?? 'sync', weight: e.data?.weight })),
  };
}

export function flowEdge(source: string, target: string, t: ConnectionType = 'sync', weight?: number): FlowEdge {
  return {
    id: `${source}->${target}`, source, target, animated: t === 'async', className: `edge-${t}`,
    data: weight == null ? { connection_type: t } : { connection_type: t, weight },
  };
}

/** Share (0–1) of its source's outgoing traffic that each edge carries; mirrors the engine's edgeShares. */
export function outgoingShares(edges: FlowEdge[]): Map<string, number> {
  const bySource = new Map<string, FlowEdge[]>();
  for (const e of edges) bySource.set(e.source, [...(bySource.get(e.source) ?? []), e]);
  const shares = new Map<string, number>();
  for (const group of bySource.values()) {
    const weights = group.map((e) => Math.max(0, e.data?.weight ?? 1));
    const total = weights.reduce((a, b) => a + b, 0);
    group.forEach((e, i) => shares.set(e.id, total > 0 ? weights[i] / total : 1 / group.length));
  }
  return shares;
}

export function flowNode(id: string, kind: ComponentType, x: number, y: number, config?: NodeConfig): FlowNode {
  return { id, type: 'component', position: { x, y }, data: { kind, config: { ...defaultConfig(kind), ...config } } };
}

export function presetFlow(p: Preset, mode: Mode) {
  if (mode === 'learn') {
    return {
      nodes: p.reference.nodes.map((n) => flowNode(n.id, n.type, n.x, n.y, n.config)),
      edges: p.reference.edges.map((e) => flowEdge(e.source, e.target, e.type, e.weight)),
    };
  }
  return { nodes: [flowNode('users', 'User', 40, 200, { number_of_users: p.users, requests_per_user: p.requestsPerUser })], edges: [] };
}
