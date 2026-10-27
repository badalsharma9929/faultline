import { describe, expect, it } from 'vitest';
import { defaultConfig } from './catalog';
import { runStressTest } from './stress';
import { simulate } from './simulate';
import type { ComponentType, Graph } from './types';

function graph(chain: [string, ComponentType, Record<string, unknown>?][]): Graph {
  return {
    nodes: chain.map(([id, type, cfg], i) => ({ id, type, config: { ...defaultConfig(type), ...cfg } as Graph['nodes'][number]['config'], position: { x: i * 200, y: 0 } })),
    edges: chain.slice(1).map(([id], i) => ({ id: `e${i}`, source: chain[i][0], target: id, connection_type: 'sync' as const })),
  };
}

const design = graph([
  ['users', 'User', { number_of_users: 1000 }],
  ['lb', 'LoadBalancer'],
  ['svc', 'Service', { replicas: 2 }],
  ['cache', 'Cache', { hit_ratio: 0.8 }],
  ['db', 'Database'],
]);

describe('runStressTest', () => {
  const report = runStressTest(design);

  it('passes at expected load and reports where it breaks', () => {
    expect(report.pass).toBe(true);
    expect(report.first_to_give).toBe('svc');
    expect(report.breaks_at_rps).toBe(2000);
  });

  it('ramps from a quarter to five times the load', () => {
    expect(report.ramp.map((p) => p.x)).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5]);
    expect(report.ramp.at(-1)!.error).toBeGreaterThan(0);
  });

  it('fails the 3× spike and blames the service, with retries', () => {
    const spike = report.scenarios.find((s) => s.id === 'spike')!;
    expect(spike.pass).toBe(false);
    expect(spike.why.join(' ')).toMatch(/svc runs at/);
    expect(spike.why.join(' ')).toMatch(/retry/);
  });

  it('cold cache pushes all reads to the database', () => {
    const cold = report.scenarios.find((s) => s.id === 'cache-cold')!;
    expect(cold.latency_ms).toBeGreaterThan(simulate(design).performance.total_latency);
  });

  it('skips scenarios for components the design does not have', () => {
    expect(report.scenarios.find((s) => s.id === 'queue-slow-consumers')!.skipped).toBeTruthy();
  });

  it('a single database instance going down fails every request that needs it', () => {
    const lose = report.scenarios.find((s) => s.id === 'db-lose-copy')!;
    expect(lose.pass).toBe(false);
    expect(lose.served).toBeCloseTo(0.8, 2);
  });
});
