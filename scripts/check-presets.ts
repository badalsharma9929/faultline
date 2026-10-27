// Prints how every reference design behaves at its stated load, so presets can be sized.
// Usage: npx vite-node scripts/check-presets.ts [id-prefix]
import { simulate } from '../src/engine/simulate';
import { PRESETS } from '../src/presets';
import { toGraph, presetFlow } from '../src/presetGraph';

const only = process.argv[2];
let bad = 0;
for (const p of PRESETS) {
  if (only && !p.id.startsWith(only)) continue;
  if (p.reference.nodes.length <= 1) continue; // sandbox: no reference design
  const { nodes, edges } = presetFlow(p, 'learn');
  const r = simulate(toGraph(nodes, edges), { latencyTargetMs: p.latencyTargetMs });
  const perf = r.performance;
  const hot = r.node_metrics.filter((m) => m.component_type !== 'User' && m.utilization >= 0.75);
  const ok = r.valid && perf.error_rate === 0 && perf.async_backlog_rps === 0 && perf.total_latency <= p.latencyTargetMs && hot.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FIX '} ${p.id.padEnd(26)} ${String(p.users).padStart(7)} rps  ${perf.total_latency.toFixed(0).padStart(4)}/${p.latencyTargetMs} ms  score ${r.score.total}  ${perf.system_status}` +
    (hot.length ? `  hot: ${hot.map((m) => `${m.component_id} ${Math.round(m.utilization * 100)}%`).join(', ')}` : '') +
    (r.valid ? '' : `  invalid: ${r.structural_errors.map((e) => e.code).join(',')}`));
}
console.log(`\n${bad} preset(s) need sizing`);
process.exit(bad ? 1 : 0);
