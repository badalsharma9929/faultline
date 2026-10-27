import { useReactFlow } from '@xyflow/react';
import { CATALOG, PALETTE_GROUPS } from '../engine/catalog';
import type { ComponentType } from '../engine/types';
import { useStore } from '../store';

export const DRAG_MIME = 'application/x-faultline-component';
const NODE_W = 176;
const NODE_H = 56;

/** Lexicographic comparison of equal-length number tuples. */
function compareRanks(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function Palette() {
  const specs = Object.values(CATALOG);
  const addComponent = useStore((s) => s.addComponent);
  const { screenToFlowPosition, flowToScreenPosition } = useReactFlow();

  /**
   * Click or keyboard: place the component in the free grid slot nearest the middle of the visible canvas,
   * preferring right and below (the usual direction of flow) and never off-screen.
   */
  const addAtCenter = (kind: ComponentType) => {
    const r = document.querySelector('.canvas')?.getBoundingClientRect();
    if (!r) return;
    const mid = screenToFlowPosition({ x: r.left + r.width / 2 - NODE_W / 2, y: r.top + r.height / 2 - NODE_H / 2 });
    const taken = useStore.getState().nodes.map((n) => n.position);
    const free = (p: { x: number; y: number }) => taken.every((t) => Math.abs(t.x - p.x) >= NODE_W + 16 || Math.abs(t.y - p.y) >= NODE_H + 16);
    const visible = (p: { x: number; y: number }) => {
      const a = flowToScreenPosition(p);
      const b = flowToScreenPosition({ x: p.x + NODE_W, y: p.y + NODE_H });
      return a.x >= r.left && a.y >= r.top && b.x <= r.right && b.y <= r.bottom;
    };
    const slots: { x: number; y: number; rank: number[] }[] = [];
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        slots.push({ x: mid.x + dx * (NODE_W + 40), y: mid.y + dy * (NODE_H + 40), rank: [ring, dx < 0 ? 1 : 0, dy < 0 ? 1 : 0, Math.abs(dy)] });
      }
    }
    slots.sort((a, b) => compareRanks(a.rank, b.rank));
    const spot = slots.find((s) => free(s) && visible(s)) ?? slots.find(free) ?? mid;
    addComponent(kind, { x: spot.x, y: spot.y });
  };

  return (
    <aside className="palette" aria-label="Components">
      <p className="palette-hint">Drag onto the canvas, or click to add.</p>
      {PALETTE_GROUPS.map((group) => (
        <section key={group}>
          <h3>{group}</h3>
          <div className="palette-group">
            {specs.filter((s) => s.group === group).map((s) => (
              <button
                key={s.type}
                type="button"
                className="palette-item"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_MIME, s.type satisfies ComponentType);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => addAtCenter(s.type)}
                title={`${s.label}: ${s.capacity ? `${s.capacity.toLocaleString()} rps, ${s.baseLatency} ms per instance` : 'traffic source'}`}
              >
                <span className="code-tag">{s.code}</span>
                {s.label}
              </button>
            ))}
          </div>
        </section>
      ))}
    </aside>
  );
}
