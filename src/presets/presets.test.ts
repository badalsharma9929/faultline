import { describe, expect, it } from 'vitest';
import { simulate } from '../engine/simulate';
import { presetFlow, toGraph } from '../presetGraph';
import { CATEGORIES, PRESETS } from '.';
import { parseFlow } from './dsl';

describe('flow syntax', () => {
  it('parses sync, async and weighted hops', () => {
    expect(parseFlow('users>lb>api>cache@9>db, api>search@1, api~>q~>wk')).toEqual([
      { source: 'users', target: 'lb' },
      { source: 'lb', target: 'api' },
      { source: 'api', target: 'cache', weight: 9 },
      { source: 'cache', target: 'db' },
      { source: 'api', target: 'search', weight: 1 },
      { source: 'api', target: 'q', type: 'async' },
      { source: 'q', target: 'wk', type: 'async' },
    ]);
  });

  it('lets a later path add a weight to an edge already seen', () => {
    expect(parseFlow('users>a>b, a>b@3')).toEqual([{ source: 'users', target: 'a' }, { source: 'a', target: 'b', weight: 3 }]);
  });

  it('rejects a malformed weight', () => {
    expect(() => parseFlow('users>a@x')).toThrow(/bad weight/);
  });
});

describe('preset library', () => {
  it('has unique ids', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('covers every category', () => {
    for (const c of CATEGORIES) expect(PRESETS.some((p) => p.category === c), c).toBe(true);
  });

  it('gives every real-world architecture its sources', () => {
    for (const p of PRESETS.filter((x) => x.category === 'Real-world architectures')) {
      expect(p.company?.sources.length, p.id).toBeGreaterThan(0);
    }
  });
});

describe.each(PRESETS.filter((p) => p.reference.nodes.length > 1))('reference design: $id', (p) => {
  const { nodes, edges } = presetFlow(p, 'learn');
  const r = simulate(toGraph(nodes, edges), { latencyTargetMs: p.latencyTargetMs });

  it('is valid and healthy at its stated peak', () => {
    expect(r.valid).toBe(true);
    expect(r.performance.error_rate).toBe(0);
    expect(r.performance.async_backlog_rps).toBe(0);
    const hot = r.node_metrics.filter((m) => m.component_type !== 'User' && m.utilization >= 0.75).map((m) => m.component_id);
    expect(hot).toEqual([]);
  });

  it('meets its latency target', () => {
    expect(r.performance.total_latency).toBeLessThanOrEqual(p.latencyTargetMs);
  });
});
