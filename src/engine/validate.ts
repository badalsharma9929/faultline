import { COMPUTE_TYPES } from './catalog';
import { orderGraph } from './graph';
import type { Finding, Graph } from './types';

export function validateGraph(graph: Graph): Finding[] {
  const errors: Finding[] = [];
  if (graph.nodes.length === 0) {
    return [{ code: 'EMPTY', severity: 'error', title: 'Canvas is empty', detail: 'Drag components from the palette to start.' }];
  }

  const users = graph.nodes.filter((n) => n.type === 'User');
  if (users.length === 0) {
    errors.push({ code: 'NO_ENTRY', severity: 'error', title: 'No traffic source', detail: 'Add a Users node so the simulation has load to send.' });
    return errors;
  }

  const { reachable, backEdges, byId } = orderGraph(graph);
  if (!graph.nodes.some((n) => COMPUTE_TYPES.includes(n.type) && reachable.has(n.id))) {
    errors.push({ code: 'NO_COMPUTE', severity: 'error', title: 'No compute on the request path', detail: 'Connect a Service or App Server downstream of your users.' });
  }

  const orphans = graph.nodes.filter((n) => !reachable.has(n.id));
  if (orphans.length) {
    errors.push({
      code: 'UNREACHABLE', severity: 'warning', nodeIds: orphans.map((n) => n.id),
      title: `${orphans.length} component${orphans.length > 1 ? 's' : ''} not on any request path`,
      detail: 'No traffic reaches these nodes, so they are left out of the simulation.',
    });
  }

  for (const e of graph.edges) {
    if (byId.get(e.target)?.type === 'User') {
      errors.push({ code: 'EDGE_INTO_USERS', severity: 'warning', nodeIds: [e.source], title: 'Edge points into Users', detail: 'Users only send traffic; this edge is ignored.' });
    }
  }
  if (backEdges.length) {
    errors.push({
      code: 'CYCLE', severity: 'warning', nodeIds: backEdges.map((e) => e.source),
      title: 'Cycle in the request path', detail: 'Edges that loop back are ignored so traffic is not counted twice.',
    });
  }
  return errors;
}
