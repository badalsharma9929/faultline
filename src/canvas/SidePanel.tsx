import type { Finding } from '../engine/types';
import type { StressReport } from '../engine/stress';
import { CATEGORIES, PRESETS } from '../presets';
import { useStore } from '../store';

const fmt = (n: number | null | undefined, d = 0) => (n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d }));

function ProblemTab() {
  const preset = useStore((s) => s.preset);
  const mode = useStore((s) => s.mode);
  return (
    <div className="tab-body">
      <p className="eyebrow">{preset.category}</p>
      <h2>{preset.name} <span className="pill">{preset.difficulty}</span></h2>
      <p>{preset.statement}</p>
      {preset.company && <p className="muted">{preset.company.name} · {preset.company.product}</p>}
      <h4>Must do</h4>
      <ul>{preset.functional.map((f) => <li key={f}>{f}</li>)}</ul>
      <h4>Must hold up</h4>
      <ul>{preset.nonFunctional.map((f) => <li key={f}>{f}</li>)}</ul>
      <p className="muted">Load: {fmt(preset.users * preset.requestsPerUser)} requests/s · latency target {preset.latencyTargetMs} ms</p>
      {mode === 'learn' && (
        <>
          <h4>Why the reference design looks like this</h4>
          <ul>{preset.reference.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </>
      )}
      {preset.company && (
        <>
          <h4>About the numbers</h4>
          <p className="muted">{preset.company.scaleNotes}</p>
          <h4>Sources</h4>
          <ul className="sources">
            {preset.company.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a></li>)}
          </ul>
        </>
      )}
      {mode === 'practice' && preset.reference.nodes.length > 1 && (
        <p className="muted">Stuck? Switch to Learn to see a reference design.</p>
      )}
    </div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const select = useStore((s) => s.select);
  return (
    <li className={`finding sev-${f.severity}`} onClick={() => f.nodeIds?.[0] && select(f.nodeIds[0])}>
      <strong>{f.title}</strong>
      <span>{f.detail}</span>
    </li>
  );
}

function ResultsTab() {
  const result = useStore((s) => s.result);
  if (!result) return <div className="tab-body muted">Press Simulate to send traffic through your design.</div>;
  const { performance: p, score } = result;
  const issues = [...result.structural_errors, ...result.findings];
  return (
    <div className="tab-body">
      <div className="score-card">
        <div className={`grade grade-${score.grade}`}>{score.grade}</div>
        <div>
          <div className="score-total">{score.total}<span>/{score.total_max}</span></div>
          <div className="muted">Architecture {score.arch_pts}/{score.arch_max} · Simulation {score.sim_pts}/{score.sim_max}</div>
        </div>
        <div className={`status status-${p.system_status}`}>{p.system_status}</div>
      </div>
      <div className="stats">
        <div><span>Incoming</span><b>{fmt(p.incoming_rps)} rps</b></div>
        <div><span>Served</span><b>{fmt(p.throughput)} rps</b></div>
        <div><span>Errors</span><b>{fmt(p.error_rate * 100, 1)}%</b></div>
        <div><span>Latency</span><b>{fmt(p.total_latency, 1)} ms</b></div>
        <div><span>Breaks at</span><b>{fmt(p.first_failure_rps)} rps</b></div>
        <div><span>Headroom</span><b>{p.capacity_headroom == null ? '—' : `${fmt(p.capacity_headroom, 2)}×`}</b></div>
      </div>
      {p.bottleneck_node_id && <p className="callout">Bottleneck: <b>{p.bottleneck_node_id}</b></p>}
      {p.async_backlog_rps > 0 && <p className="callout">Async backlog grows by <b>{fmt(p.async_backlog_rps)}</b> jobs/s</p>}
      <h4>Issues ({issues.length})</h4>
      <ul className="findings">{issues.map((f, i) => <FindingRow key={f.code + i} f={f} />)}</ul>
      <h4>Score</h4>
      <ul className="ledger">
        {score.contributions.map((c) => <li key={c.label}><span>{c.label}</span><b>+{c.points}</b></li>)}
        {score.penalties.map((c, i) => <li key={c.label + i} className="neg"><span>{c.label}</span><b>−{c.points}</b></li>)}
      </ul>
    </div>
  );
}

function RampChart({ report }: { report: StressReport }) {
  const W = 300, H = 140, pad = 28;
  const maxLat = Math.max(...report.ramp.map((r) => r.latency_ms), 1);
  const xs = (i: number) => pad + (i / (report.ramp.length - 1)) * (W - pad - 8);
  const yLat = (v: number) => H - pad - (v / maxLat) * (H - pad - 10);
  const yErr = (v: number) => H - pad - v * (H - pad - 10);
  const line = (f: (r: StressReport['ramp'][number]) => number) => report.ramp.map((r, i) => `${i ? 'L' : 'M'}${xs(i)},${f(r)}`).join(' ');
  const loadIdx = report.ramp.findIndex((r) => r.x === 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ramp" role="img" aria-label="Latency and error rate as traffic ramps up">
      <line x1={xs(loadIdx)} x2={xs(loadIdx)} y1={8} y2={H - pad} className="ramp-load" />
      <path d={line((r) => yLat(r.latency_ms))} className="ramp-lat" />
      <path d={line((r) => yErr(r.error))} className="ramp-err" />
      {report.ramp.map((r, i) => <text key={r.x} x={xs(i)} y={H - 10} className="ramp-tick">{r.x}×</text>)}
      <text x={pad} y={12} className="ramp-legend lat">latency (max {Math.round(maxLat)} ms)</text>
      <text x={W - 8} y={12} textAnchor="end" className="ramp-legend err">errors</text>
    </svg>
  );
}

function StressTab() {
  const report = useStore((s) => s.stress);
  if (!report) return <div className="tab-body muted">Run the stress test to ramp traffic and break things on purpose.</div>;
  return (
    <div className="tab-body">
      <div className={`verdict ${report.pass ? 'pass' : 'fail'}`}>
        {report.pass ? 'Holds at expected load' : 'Fails at expected load'}
        <span>{fmt(report.load_rps)} rps · breaks at {fmt(report.breaks_at_rps)} rps ({report.first_to_give ?? '—'} gives first)</span>
      </div>
      <RampChart report={report} />
      <h4>Failure drills</h4>
      <ul className="scenarios">
        {report.scenarios.map((s) => (
          <li key={s.id} className={s.skipped ? 'skipped' : s.pass ? 'pass' : 'fail'}>
            <div className="sc-head">
              <span className="sc-mark">{s.skipped ? '–' : s.pass ? '✓' : '✗'}</span>
              <strong>{s.name}</strong>
              <span className="pill">{s.area}</span>
            </div>
            <p className="muted">{s.skipped ?? s.description}</p>
            {!s.skipped && <p className="sc-stats">served {fmt(s.served * 100, 1)}% · {fmt(s.latency_ms, 1)} ms</p>}
            {s.why.map((w) => <p key={w} className="sc-why">{w}</p>)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LibraryTab() {
  const current = useStore((s) => s.preset.id);
  const loadPreset = useStore((s) => s.loadPreset);
  return (
    <div className="tab-body library">
      <p className="muted">{PRESETS.length - 1} problems and architectures. Practice starts from a blank canvas; Learn opens the reference design.</p>
      {CATEGORIES.map((c) => {
        const items = PRESETS.filter((p) => p.category === c);
        if (!items.length) return null;
        return (
          <section key={c}>
            <h4>{c} <span className="count">{items.length}</span></h4>
            <ul>
              {items.map((p) => (
                <li key={p.id} className={p.id === current ? 'current' : ''}>
                  <div className="lib-main">
                    <span className="lib-name">{p.name}</span>
                    <span className="lib-meta">{p.company ? p.company.product : `${p.users.toLocaleString('en-US')} rps · ${p.difficulty}`}</span>
                  </div>
                  <div className="lib-actions">
                    {p.category !== 'Real-world architectures' && <button onClick={() => loadPreset(p.id, 'practice')}>Practice</button>}
                    {p.reference.nodes.length > 1 && <button onClick={() => loadPreset(p.id, 'learn')}>Learn</button>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function SidePanel() {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  return (
    <aside className="side">
      <nav className="tabs">
        {(['library', 'problem', 'results', 'stress'] as const).map((p) => (
          <button key={p} className={panel === p ? 'on' : ''} onClick={() => setPanel(p)}>{p === 'stress' ? 'Stress test' : p[0].toUpperCase() + p.slice(1)}</button>
        ))}
      </nav>
      {panel === 'library' && <LibraryTab />}
      {panel === 'problem' && <ProblemTab />}
      {panel === 'results' && <ResultsTab />}
      {panel === 'stress' && <StressTab />}
    </aside>
  );
}
