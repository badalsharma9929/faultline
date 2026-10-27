// Replays the captured reference-simulator probes (research/probes) through our engine
// and checks we land on the same numbers. See research/FINDINGS.md for what is exact vs fitted.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { simulate } from './simulate';
import type { Graph } from './types';

const DIR = path.resolve(__dirname, '../../research/probes');
const probes = fs.readdirSync(DIR).filter((f) => f.startsWith('sim-')).map((f) => ({ name: f, ...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }));

function toGraph(req: any): Graph {
  return {
    nodes: req.graph.nodes.map((n: any) => ({ id: n.id, type: n.type, config: n.config, position: n.position })),
    edges: req.graph.edges.map((e: any, i: number) => ({ id: `e${i}`, source: e.source, target: e.target, connection_type: e.connection_type })),
  };
}

/** Exact below light load, within a relative tolerance where queueing is approximated. */
function closeLatency(ours: number, theirs: number, rel = 0.12) {
  expect(Math.abs(ours - theirs)).toBeLessThanOrEqual(Math.max(1, theirs * rel));
}

describe.each(probes)('$name', ({ request, response }) => {
  const result = simulate(toGraph(request));
  const theirs = new Map<string, any>(response.node_metrics.map((m: any) => [m.component_id, m]));

  it('matches per-node flow and capacity', () => {
    for (const m of result.node_metrics) {
      const t = theirs.get(m.component_id);
      if (!t || m.component_type === 'User') continue;
      expect(m.incoming_rps, m.component_id).toBeCloseTo(t.incoming_rps, 0);
      expect(m.effective_rps, m.component_id).toBeCloseTo(t.effective_rps, 0);
      expect(m.effective_capacity, m.component_id).toBeCloseTo(t.effective_capacity, 0);
      expect(m.utilization, m.component_id).toBeCloseTo(t.utilization, 2);
      expect(m.status, m.component_id).toBe(t.status);
    }
  });

  it('matches per-node latency and percentiles', () => {
    for (const m of result.node_metrics) {
      const t = theirs.get(m.component_id);
      if (!t || m.component_type === 'User') continue;
      closeLatency(m.latency, t.latency);
      closeLatency(m.latency_p95_ms, t.latency_p95_ms);
      closeLatency(m.latency_p99_ms, t.latency_p99_ms);
    }
  });

  it('matches system performance', () => {
    const p = response.performance;
    expect(result.performance.incoming_rps).toBe(p.incoming_rps);
    expect(result.performance.throughput).toBeCloseTo(p.throughput, 0);
    expect(result.performance.error_rate).toBeCloseTo(p.error_rate, 3);
    closeLatency(result.performance.total_latency, p.total_latency, 0.1);
    expect(result.performance.system_status).toBe(p.system_status);
    expect(result.performance.bottleneck_node_id).toBe(p.bottleneck_node_id);
    expect(result.performance.first_failure_rps).toBeCloseTo(p.first_failure_rps, 0);
    expect(result.performance.capacity_headroom).toBeCloseTo(p.capacity_headroom, 2);
  });

  it('scores within 3 points', () => {
    expect(Math.abs(result.score.total - response.score.total)).toBeLessThanOrEqual(3);
  });
});
