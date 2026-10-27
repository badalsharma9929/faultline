import type { ComponentType, ConnectionType, NodeConfig } from '../engine/types';

export type Difficulty = 'Beginner' | 'Intermediate' | 'Advanced';

export const CATEGORIES = [
  'Foundations',
  'Social & messaging',
  'Media & streaming',
  'Commerce & booking',
  'Payments & finance',
  'Maps & logistics',
  'Productivity & collaboration',
  'Data & infrastructure',
  'AI systems',
  'Real-world architectures',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface PresetNode { id: string; type: ComponentType; x: number; y: number; config?: NodeConfig }
export interface PresetEdge { source: string; target: string; type?: ConnectionType; weight?: number }

export interface Preset {
  id: string;
  name: string;
  category: Category;
  difficulty: Difficulty;
  statement: string;
  functional: string[];
  nonFunctional: string[];
  users: number;
  requestsPerUser: number;
  latencyTargetMs: number;
  reference: { nodes: PresetNode[]; edges: PresetEdge[]; notes: string[] };
  /** Real-world architectures only. */
  company?: { name: string; product: string; scaleNotes: string; sources: { title: string; url: string }[] };
}

/** [id, type, config overrides] for every node except the Users entry point. */
export type NodeSpec = [id: string, type: ComponentType, config?: NodeConfig];

export interface ProblemInput {
  id: string;
  name: string;
  category: Category;
  difficulty: Difficulty;
  statement: string;
  functional: string[];
  nonFunctional: string[];
  /** Peak requests per second; modelled as this many users sending one request per second. */
  rps: number;
  latencyTargetMs: number;
  nodes: NodeSpec[];
  /**
   * Request paths, comma separated. `a>b` is a sync call, `a~>b` an async hand-off.
   * `b@N` gives that hop a relative traffic weight (default 1, so siblings split evenly).
   * Paths start at `users`, e.g. "users>lb>api>cache@9>db, api>db@1, api~>q~>wk>db".
   */
  flow: string;
  notes: string[];
  company?: Preset['company'];
}

const COL = 270;
const ROW = 110;

export function parseFlow(flow: string): PresetEdge[] {
  const edges: PresetEdge[] = [];
  const seen = new Map<string, PresetEdge>();
  const node = (token: string) => {
    const [id, w] = token.split('@');
    return { id: id.trim(), weight: w === undefined ? undefined : Number(w) };
  };
  for (const path of flow.split(',').map((p) => p.trim()).filter(Boolean)) {
    const tokens = path.split(/(~>|>)/).map((t) => t.trim());
    for (let i = 0; i + 2 < tokens.length; i += 2) {
      const source = node(tokens[i]).id;
      const { id: target, weight } = node(tokens[i + 2]);
      if (weight !== undefined && !(weight >= 0)) throw new Error(`bad weight in "${tokens[i + 2]}"`);
      const key = `${source}->${target}`;
      const existing = seen.get(key);
      if (existing) {
        if (weight !== undefined) existing.weight = weight;
        continue;
      }
      const edge: PresetEdge = { source, target };
      if (tokens[i + 1] === '~>') edge.type = 'async';
      if (weight !== undefined) edge.weight = weight;
      seen.set(key, edge);
      edges.push(edge);
    }
  }
  return edges;
}

/** Columns by longest path from Users, rows by first appearance, each column centred vertically. */
export function layout(ids: string[], edges: PresetEdge[]): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>([['users', 0]]);
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const d = (depth.get(e.source) ?? 0) + 1;
      if (depth.has(e.source) && (depth.get(e.target) ?? -1) < d && d <= ids.length) {
        depth.set(e.target, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), id]);
  }
  const tallest = Math.max(...[...columns.values()].map((c) => c.length));
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, col] of columns) {
    const top = ((tallest - col.length) * ROW) / 2;
    col.forEach((id, row) => pos.set(id, { x: d * COL, y: top + row * ROW }));
  }
  return pos;
}

export function problem(p: ProblemInput): Preset {
  const edges = parseFlow(p.flow);
  const known = new Set(['users', ...p.nodes.map((n) => n[0])]);
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target)) throw new Error(`${p.id}: flow mentions unknown node in ${e.source} -> ${e.target}`);
  }
  const ids = ['users', ...p.nodes.map((n) => n[0])];
  const pos = layout(ids, edges);
  const nodes: PresetNode[] = [
    { id: 'users', type: 'User', ...pos.get('users')!, config: { number_of_users: p.rps, requests_per_user: 1 } },
    ...p.nodes.map(([id, type, config]) => ({ id, type, ...pos.get(id)!, config: { name: id, ...config } })),
  ];
  return {
    id: p.id, name: p.name, category: p.category, difficulty: p.difficulty, statement: p.statement,
    functional: p.functional, nonFunctional: p.nonFunctional, users: p.rps, requestsPerUser: 1,
    latencyTargetMs: p.latencyTargetMs, reference: { nodes, edges, notes: p.notes }, company: p.company,
  };
}
