import type { Graph, GraphEdge } from './types';

/** Orders reachable nodes from the entry points and drops edges that close a cycle. */
export function orderGraph(graph: Graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphEdge[]>();
  for (const n of graph.nodes) out.set(n.id, []);
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue;
    if (byId.get(e.target)!.type === 'User') continue;
    out.get(e.source)!.push(e);
  }
  const entries = graph.nodes.filter((n) => n.type === 'User');
  const state = new Map<string, 'visiting' | 'done'>();
  const post: string[] = [];
  const backEdges = new Set<GraphEdge>();
  const visit = (id: string) => {
    state.set(id, 'visiting');
    for (const e of out.get(id)!) {
      const s = state.get(e.target);
      if (s === 'visiting') backEdges.add(e);
      else if (!s) visit(e.target);
    }
    state.set(id, 'done');
    post.push(id);
  };
  for (const u of entries) if (!state.has(u.id)) visit(u.id);
  for (const [id, edges] of out) out.set(id, edges.filter((e) => !backEdges.has(e)));
  return { order: post.reverse(), out, byId, entries, reachable: new Set(post), backEdges: [...backEdges] };
}

/** Fraction of its source's outgoing traffic each edge carries, from relative weights (default 1 = even split). */
export function edgeShares(out: Map<string, GraphEdge[]>): Map<GraphEdge, number> {
  const shares = new Map<GraphEdge, number>();
  for (const edges of out.values()) {
    const weights = edges.map((e) => (Number.isFinite(e.weight) ? Math.max(0, e.weight!) : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    edges.forEach((e, i) => shares.set(e, total > 0 ? weights[i] / total : 1 / edges.length));
  }
  return shares;
}
