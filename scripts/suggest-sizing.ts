// Suggests instance counts for reference designs whose nodes run hot (>= 70%) at the stated peak.
// Prints JSON lines: { preset, node, type, field, value } aiming for ~60% utilisation.
// Usage: npx vite-node scripts/suggest-sizing.ts
import { CATALOG } from '../src/engine/catalog';
import { simulate } from '../src/engine/simulate';
import { PRESETS } from '../src/presets';
import { presetFlow, toGraph } from '../src/presetGraph';

for (const p of PRESETS) {
  if (p.category === 'Real-world architectures' || p.reference.nodes.length <= 1) continue;
  const { nodes, edges } = presetFlow(p, 'learn');
  const r = simulate(toGraph(nodes, edges));
  for (const m of r.node_metrics) {
    if (m.component_type === 'User' || m.utilization < 0.7) continue;
    const cfg = nodes.find((n) => n.id === m.component_id)!.data.config;
    const factor = Math.min(m.utilization, 50) / 0.6;
    const type = m.component_type;
    const field = type === 'Database' ? 'shards' : CATALOG[type].params.some((x) => x.key === 'replicas') ? 'replicas' : 'capacity';
    const current = Number(cfg[field] ?? (field === 'capacity' ? CATALOG[type].capacity : 1));
    console.log(JSON.stringify({ preset: p.id, node: m.component_id, type, field, value: Math.ceil(current * factor) }));
  }
}
