import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, type DragEvent } from 'react';
import { CATALOG } from './engine/catalog';
import type { ComponentType, Graph } from './engine/types';
import { ComponentNode } from './canvas/ComponentNode';
import { Inspector } from './canvas/Inspector';
import { DRAG_MIME, Palette } from './canvas/Palette';
import { SidePanel } from './canvas/SidePanel';
import { CATEGORIES, PRESETS } from './presets';
import { outgoingShares } from './presetGraph';
import { toGraph, useStore } from './store';

const nodeTypes = { component: ComponentNode };
/** Wide real-world architectures need to zoom out further than React Flow's 0.5 default. */
const MIN_ZOOM = 0.2;

function Canvas() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addComponent, select, layoutVersion } = useStore();
  const { screenToFlowPosition, fitView, getInternalNode } = useReactFlow();

  // Label each branch of a fan-out with the share of traffic it carries.
  const labelledEdges = useMemo(() => {
    const shares = outgoingShares(edges);
    const outDegree = new Map<string, number>();
    for (const e of edges) outDegree.set(e.source, (outDegree.get(e.source) ?? 0) + 1);
    const fanOut = new Set([...outDegree].filter(([, n]) => n > 1).map(([id]) => id));
    const callsAll = new Set(nodes.filter((n) => n.data.config.fanout === 'all').map((n) => n.id));
    const label = (e: (typeof edges)[number]) => (callsAll.has(e.source) ? 'all' : `${Math.round(shares.get(e.id)! * 100)}%`);
    return edges.map((e) => (fanOut.has(e.source) ? { ...e, label: label(e), labelBgPadding: [4, 2] as [number, number], labelBgBorderRadius: 4 } : e));
  }, [edges, nodes]);

  // A new problem, mode or import replaces the whole design: frame it once every new node has been measured.
  useEffect(() => {
    if (layoutVersion === 0) return;
    let frame = 0;
    let tries = 0;
    const tick = () => {
      const ids = useStore.getState().nodes.map((n) => n.id);
      const ready = ids.every((id) => getInternalNode(id)?.measured?.width);
      if (ready || ++tries > 60) fitView({ padding: 0.12, minZoom: MIN_ZOOM, maxZoom: 1, duration: 300 });
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [layoutVersion, fitView, getInternalNode]);

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData(DRAG_MIME) as ComponentType;
    if (!kind || !(kind in CATALOG)) return;
    addComponent(kind, screenToFlowPosition({ x: e.clientX - 80, y: e.clientY - 30 }));
  }, [addComponent, screenToFlowPosition]);

  return (
    <div className="canvas" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={labelledEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneClick={() => select(null)}
        deleteKeyCode={['Backspace', 'Delete']}
        colorMode="system"
        minZoom={MIN_ZOOM}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor="var(--minimap-node)" maskColor="var(--minimap-mask)" />
      </ReactFlow>
    </div>
  );
}

function TopBar() {
  const { preset, mode, newEdgeType, loadPreset, setNewEdgeType, runSimulation, runStress, importGraph } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);

  const exportJson = () => {
    const { nodes, edges } = useStore.getState();
    const blob = new Blob([JSON.stringify({ preset: preset.id, ...toGraph(nodes, edges) }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${preset.id}-design.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = async (file: File) => {
    try {
      const g = JSON.parse(await file.text()) as Graph;
      if (Array.isArray(g.nodes) && Array.isArray(g.edges)) importGraph(g);
    } catch {
      alert('That file is not a Faultline design.');
    }
  };

  return (
    <header className="topbar">
      <div className="brand">Faultline<span>system design simulator</span></div>
      <select value={preset.id} onChange={(e) => loadPreset(e.target.value, mode)} aria-label="Problem">
        {CATEGORIES.map((c) => {
          const items = PRESETS.filter((p) => p.category === c);
          return items.length ? (
            <optgroup key={c} label={c}>
              {items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
          ) : null;
        })}
      </select>
      <div className="seg" role="group" aria-label="Mode">
        <button className={mode === 'practice' ? 'on' : ''} onClick={() => loadPreset(preset.id, 'practice')}>Practice</button>
        <button className={mode === 'learn' ? 'on' : ''} onClick={() => loadPreset(preset.id, 'learn')}>Learn</button>
      </div>
      <div className="seg" role="group" aria-label="New connection type">
        <button className={newEdgeType === 'sync' ? 'on' : ''} onClick={() => setNewEdgeType('sync')}>Sync edge</button>
        <button className={newEdgeType === 'async' ? 'on' : ''} onClick={() => setNewEdgeType('async')}>Async edge</button>
      </div>
      <div className="spacer" />
      <button onClick={exportJson}>Export</button>
      <button onClick={() => fileRef.current?.click()}>Import</button>
      <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
      <button className="secondary" onClick={runStress}>Stress test</button>
      <button className="primary" onClick={runSimulation}>Simulate</button>
    </header>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <div className="app">
        <TopBar />
        <div className="workspace">
          <div className="left">
            <Palette />
            <Inspector />
          </div>
          <Canvas />
          <SidePanel />
        </div>
      </div>
    </ReactFlowProvider>
  );
}
