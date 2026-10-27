import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type EdgeChange, type NodeChange } from '@xyflow/react';
import { create } from 'zustand';
import { simulate } from './engine/simulate';
import { runStressTest, type StressReport } from './engine/stress';
import type { ComponentType, ConfigValue, ConnectionType, Graph, SimResult } from './engine/types';
import { flowEdge, flowNode, presetFlow, toGraph, type FlowEdge, type FlowNode, type Mode } from './presetGraph';
import { PRESETS, type Preset } from './presets';

export { toGraph, type ComponentNodeData, type FlowEdge, type FlowNode, type Mode } from './presetGraph';

export type Panel = 'library' | 'problem' | 'results' | 'stress';

const STORAGE_KEY = 'faultline:v2';

interface State {
  preset: Preset;
  mode: Mode;
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedId: string | null;
  counter: number;
  newEdgeType: ConnectionType;
  result: SimResult | null;
  stress: StressReport | null;
  panel: Panel;
  /** Bumped whenever the whole design is replaced, so the canvas can re-frame it. */
  layoutVersion: number;
  onNodesChange: (c: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (c: EdgeChange<FlowEdge>[]) => void;
  onConnect: (c: Connection) => void;
  addComponent: (kind: ComponentType, position: { x: number; y: number }) => void;
  updateConfig: (id: string, key: string, value: ConfigValue) => void;
  setEdgeType: (id: string, t: ConnectionType) => void;
  /** Sets this edge's share of its source's traffic (0–100%); sibling edges keep their proportions of the rest. */
  setEdgeShare: (id: string, percent: number) => void;
  removeSelected: () => void;
  select: (id: string | null) => void;
  setNewEdgeType: (t: ConnectionType) => void;
  setPanel: (p: Panel) => void;
  loadPreset: (id: string, mode: Mode) => void;
  runSimulation: () => void;
  runStress: () => void;
  importGraph: (g: Graph) => void;
}

function loadSaved(): Partial<State> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    const preset = PRESETS.find((p) => p.id === s.presetId);
    return preset ? { preset, mode: s.mode, nodes: s.nodes, edges: s.edges, counter: s.counter } : null;
  } catch {
    return null;
  }
}

const initialPreset = PRESETS.find((p) => p.id === 'library-management') ?? PRESETS[0];
const saved = loadSaved();

export const useStore = create<State>((set, get) => {
  /** Any design change invalidates previous results. */
  const changed = (patch: Partial<State>) => set({ ...patch, result: null, stress: null });
  return {
    preset: initialPreset,
    mode: 'practice',
    ...presetFlow(initialPreset, 'practice'),
    counter: 1,
    ...saved,
    selectedId: null,
    newEdgeType: 'sync',
    result: null,
    stress: null,
    panel: 'problem',
    layoutVersion: 0,

    onNodesChange: (changes) => {
      const structural = changes.some((c) => c.type === 'remove' || c.type === 'add');
      const next = applyNodeChanges(changes, get().nodes);
      if (structural) changed({ nodes: next });
      else set({ nodes: next });
      const sel = changes.find((c) => c.type === 'select' && c.selected);
      if (sel && sel.type === 'select') set({ selectedId: sel.id });
    },
    onEdgesChange: (changes) => {
      const next = applyEdgeChanges(changes, get().edges);
      if (changes.some((c) => c.type === 'remove')) changed({ edges: next });
      else set({ edges: next });
      const sel = changes.find((c) => c.type === 'select' && c.selected);
      if (sel && sel.type === 'select') set({ selectedId: sel.id });
    },
    onConnect: (c) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const e = flowEdge(c.source, c.target, get().newEdgeType);
      changed({ edges: addEdge(e, get().edges) });
    },
    addComponent: (kind, position) => {
      const n = get().counter;
      const id = `${kind.toLowerCase()}-${n}`;
      changed({ nodes: [...get().nodes, flowNode(id, kind, position.x, position.y)], counter: n + 1, selectedId: id });
    },
    updateConfig: (id, key, value) =>
      changed({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, config: { ...n.data.config, [key]: value } } } : n)) }),
    setEdgeType: (id, t) =>
      changed({ edges: get().edges.map((e) => (e.id === id ? { ...e, data: { ...e.data, connection_type: t }, animated: t === 'async', className: `edge-${t}` } : e)) }),
    setEdgeShare: (id, percent) => {
      const edges = get().edges;
      const edge = edges.find((e) => e.id === id);
      if (!edge) return;
      const siblings = edges.filter((e) => e.source === edge.source && e.id !== id);
      if (!siblings.length) return;
      const pct = Math.min(100, Math.max(0, percent));
      const others = siblings.reduce((a, e) => a + Math.max(0, e.data?.weight ?? 1), 0);
      const weightOf = (e: FlowEdge) => {
        if (e.id === id) return pct;
        if (!siblings.includes(e)) return e.data?.weight;
        return others > 0 ? ((100 - pct) * Math.max(0, e.data?.weight ?? 1)) / others : (100 - pct) / siblings.length;
      };
      changed({ edges: edges.map((e) => (e.id === id || siblings.includes(e) ? { ...e, data: { connection_type: e.data?.connection_type ?? 'sync', weight: weightOf(e) } } : e)) });
    },
    removeSelected: () => {
      const id = get().selectedId;
      if (!id) return;
      changed({
        nodes: get().nodes.filter((n) => n.id !== id),
        edges: get().edges.filter((e) => e.id !== id && e.source !== id && e.target !== id),
        selectedId: null,
      });
    },
    select: (id) => set({ selectedId: id }),
    setNewEdgeType: (t) => set({ newEdgeType: t }),
    setPanel: (p) => set({ panel: p }),
    loadPreset: (id, mode) => {
      const preset = PRESETS.find((p) => p.id === id) ?? initialPreset;
      changed({ preset, mode, ...presetFlow(preset, mode), counter: 1, selectedId: null, panel: 'problem', layoutVersion: get().layoutVersion + 1 });
    },
    runSimulation: () => {
      const { nodes, edges, preset } = get();
      set({ result: simulate(toGraph(nodes, edges), { latencyTargetMs: preset.latencyTargetMs }), panel: 'results' });
    },
    runStress: () => {
      const { nodes, edges, preset } = get();
      const g = toGraph(nodes, edges);
      set({ result: simulate(g, { latencyTargetMs: preset.latencyTargetMs }), stress: runStressTest(g, preset.latencyTargetMs), panel: 'stress' });
    },
    importGraph: (g) =>
      changed({
        nodes: g.nodes.map((n) => flowNode(n.id, n.type, n.position.x, n.position.y, n.config)),
        edges: g.edges.map((e) => flowEdge(e.source, e.target, e.connection_type, e.weight)),
        counter: g.nodes.length + 1,
        selectedId: null,
        layoutVersion: get().layoutVersion + 1,
      }),
  };
});

useStore.subscribe((s) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ presetId: s.preset.id, mode: s.mode, nodes: s.nodes, edges: s.edges, counter: s.counter }));
  } catch {
    /* storage unavailable: the session still works, it just isn't remembered */
  }
});
