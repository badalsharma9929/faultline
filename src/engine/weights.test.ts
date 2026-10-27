import { describe, expect, it } from 'vitest';
import { defaultConfig } from './catalog';
import { simulate } from './simulate';
import type { ComponentType, Graph, GraphEdge } from './types';

const node = (id: string, type: ComponentType, cfg: Record<string, unknown> = {}) =>
  ({ id, type, config: { ...defaultConfig(type), ...cfg } as Graph['nodes'][number]['config'], position: { x: 0, y: 0 } });
const edge = (source: string, target: string, weight?: number, connection_type: GraphEdge['connection_type'] = 'sync'): GraphEdge =>
  ({ id: `${source}->${target}`, source, target, connection_type, weight });

function design(readWeight?: number, writeWeight?: number): Graph {
  return {
    nodes: [node('users', 'User', { number_of_users: 1000 }), node('api', 'Service', { replicas: 2 }), node('reads', 'SearchIndex'), node('writes', 'Database')],
    edges: [edge('users', 'api'), edge('api', 'reads', readWeight), edge('api', 'writes', writeWeight)],
  };
}
const rps = (g: Graph, id: string) => simulate(g).node_metrics.find((m) => m.component_id === id)!.incoming_rps;

describe('edge weights', () => {
  it('split evenly when no weights are set', () => {
    expect(rps(design(), 'reads')).toBe(500);
    expect(rps(design(), 'writes')).toBe(500);
  });

  it('split in proportion to relative weights', () => {
    expect(rps(design(9, 1), 'reads')).toBe(900);
    expect(rps(design(9, 1), 'writes')).toBe(100);
    expect(rps(design(90, 10), 'writes')).toBe(100);
  });

  it('treat a missing weight as 1', () => {
    expect(rps(design(3), 'reads')).toBe(750);
  });

  it('weight user-facing latency by traffic share', () => {
    // 20 (api) + 0.9 × 12 (index) + 0.1 × 80 (database), no queueing at this load.
    expect(simulate(design(9, 1)).performance.total_latency).toBeCloseTo(22 + 0.9 * 12 + 0.1 * 80, 0);
  });

  it('weight error rate by traffic share', () => {
    const g = design(1, 3);
    g.nodes.find((n) => n.id === 'writes')!.config.capacity = 250; // 750 rps arrive, 250 served
    expect(simulate(g).performance.error_rate).toBeCloseTo(0.75 * (500 / 750), 3);
  });

  it('fall back to an even split when every weight is zero', () => {
    expect(rps(design(0, 0), 'reads')).toBe(500);
  });
});

describe("fan-out mode 'all'", () => {
  function callAll(extra: Partial<Record<'readsCap' | 'writesCap', number>> = {}, weights: [number?, number?] = []): Graph {
    const g = design(...weights);
    g.nodes.find((n) => n.id === 'api')!.config.fanout = 'all';
    if (extra.readsCap) g.nodes.find((n) => n.id === 'reads')!.config.capacity = extra.readsCap;
    if (extra.writesCap) g.nodes.find((n) => n.id === 'writes')!.config.capacity = extra.writesCap;
    return g;
  }

  it('sends every request down every branch', () => {
    expect(rps(callAll(), 'reads')).toBe(1000);
    expect(rps(callAll(), 'writes')).toBe(1000);
  });

  it('ignores weights', () => {
    expect(rps(callAll({}, [9, 1]), 'writes')).toBe(1000);
  });

  it('waits for the slowest sync branch', () => {
    const p = simulate(callAll({ writesCap: 4000 })).performance;
    // api 22 ms, then max(index 12 ms, database 80 ms), with no queueing at this load.
    expect(p.total_latency).toBeCloseTo(22 + 80, 0);
  });

  it('fails a request when any sync branch fails', () => {
    // reads serve 50%, writes serve 25%: 0.5 × 0.25 of requests survive both.
    expect(simulate(callAll({ readsCap: 500, writesCap: 250 })).performance.error_rate).toBeCloseTo(1 - 0.5 * 0.25, 3);
  });

  it('does not wait on async branches', () => {
    const g = callAll({ writesCap: 4000 });
    g.edges.find((e) => e.target === 'writes')!.connection_type = 'async';
    expect(simulate(g).performance.total_latency).toBeCloseTo(22 + 12, 0);
  });

  it('counts the full load towards headroom', () => {
    // writes see 1 × entry traffic, so they saturate at their own 2,000 rps capacity.
    expect(simulate(callAll()).performance.first_failure_rps).toBe(2000);
  });
});
