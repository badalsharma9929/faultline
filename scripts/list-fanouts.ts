// Lists every node with more than one outgoing edge in the reference designs, with each branch's current share.
// Usage: npx vite-node scripts/list-fanouts.ts [id-prefix]
import { PRESETS } from '../src/presets';

const only = process.argv[2];
for (const p of PRESETS) {
  if (only && !p.id.startsWith(only)) continue;
  const bySource = new Map<string, typeof p.reference.edges>();
  for (const e of p.reference.edges) bySource.set(e.source, [...(bySource.get(e.source) ?? []), e]);
  for (const [source, edges] of bySource) {
    if (edges.length < 2) continue;
    const total = edges.reduce((a, e) => a + (e.weight ?? 1), 0);
    const branches = edges.map((e) => `${e.target}${e.type === 'async' ? '(async)' : ''} ${Math.round(((e.weight ?? 1) / total) * 100)}%`);
    console.log(`${p.id.padEnd(24)} ${source.padEnd(16)} → ${branches.join(' | ')}`);
  }
}
