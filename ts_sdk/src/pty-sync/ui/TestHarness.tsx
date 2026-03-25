import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import '@xterm/xterm/css/xterm.css';
import './xterm-overrides.css';
import { generateScenarioSequence } from '../generator/TestSequenceGenerator.js';
import { validateReport } from '../validator/Validator.js';
import { PREDEFINED_SCENARIOS } from './scenarios.js';
import { useScrollSync } from './useScrollSync.js';
import { ScrollPointerCol } from './ScrollPointerCol.js';
import { TimeScaleCol } from './TimeScaleCol.js';
import { StreamMapCanvas } from './StreamMapCanvas.js';
import { CommentCol } from './CommentCol.js';
import { XtermScrollbar } from './XtermScrollbar.js';
import { XtermToolbar } from './XtermToolbar.js';
import { SelectionToolbar } from './SelectionToolbar.js';
import type { SelectionContext } from './XtermToolbar.js';
import { writeToXterm } from '../adapter/writeToXterm.js';
import { useXtermSetup } from './useXtermSetup.js';
import type {
  SimulationReport,
  EnrichedSequence,
  PlaybackValidationReport,
  EnvSetup,
  ExpectedLineCoord,
} from '../types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'generated' | 'running' | 'ran' | 'validated';
type Tab = 'packets' | 'simulation' | 'validation';

interface TestData {
  enriched: EnrichedSequence;
  report: SimulationReport;
  env: EnvSetup;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const decoder = new TextDecoder();

const PHASE_COLORS: Record<Phase, string> = {
  idle:      '#555',
  generated: '#7c6f00',
  running:   '#005faf',
  ran:       '#1a6b1a',
  validated: '#7c2d12',
};

const PHASE_LABELS: Record<Phase, string> = {
  idle:      'idle',
  generated: 'generated',
  running:   'running…',
  ran:       'ran',
  validated: 'validated',
};

const TAB_LABELS: Record<Tab, string> = {
  packets:    'Packets',
  simulation: 'Simulation',
  validation: 'Validation',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtBytes(n: number) {
  return `${n}B`;
}

function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

// ─── ControlBar ──────────────────────────────────────────────────────────────

interface ControlBarProps {
  scenarioKey: string;
  onScenarioChange: (k: string) => void;
  seed: number;
  onSeedChange: (n: number) => void;
  phase: Phase;
  onGenerate: () => void;
  onRun: () => void;
  onValidate: () => void;
}

function ControlBar({
  scenarioKey, onScenarioChange,
  seed, onSeedChange,
  phase, onGenerate, onRun, onValidate,
}: ControlBarProps) {
  return (
    <div style={styles.controlBar}>
      <div style={styles.controlGroup}>
        <label style={styles.label}>Scenario</label>
        <select
          data-testid="scenario-select"
          value={scenarioKey}
          onChange={e => onScenarioChange(e.target.value)}
          style={styles.select}
        >
          {Object.entries(PREDEFINED_SCENARIOS).map(([k, def]) => (
            <option key={k} value={k}>{def.label}</option>
          ))}
        </select>
      </div>

      <div style={styles.controlGroup}>
        <label style={styles.label}>Seed</label>
        <input
          data-testid="seed-input"
          type="number"
          value={seed}
          min={0}
          onChange={e => onSeedChange(Number(e.target.value))}
          style={{ ...styles.input, width: 70 }}
        />
      </div>

      <div style={styles.controlSep} />

      <button
        data-testid="btn-generate"
        onClick={onGenerate}
        style={{ ...styles.btn, ...styles.btnPrimary }}
      >
        Generate
      </button>

      <button
        data-testid="btn-run"
        onClick={onRun}
        disabled={phase === 'idle' || phase === 'running'}
        style={{ ...styles.btn, ...((phase === 'idle' || phase === 'running') ? styles.btnDisabled : styles.btnSecondary) }}
      >
        Run on Terminal
      </button>

      <button
        data-testid="btn-validate"
        onClick={onValidate}
        disabled={phase !== 'ran' && phase !== 'validated'}
        style={{ ...styles.btn, ...((phase !== 'ran' && phase !== 'validated') ? styles.btnDisabled : styles.btnSuccess) }}
      >
        Validate
      </button>

      <PhaseBadge phase={phase} />
    </div>
  );
}

// ─── PhaseBadge ──────────────────────────────────────────────────────────────

function PhaseBadge({ phase }: { phase: Phase }) {
  return (
    <span
      data-testid="phase-badge"
      style={{ ...styles.badge, background: PHASE_COLORS[phase] }}
    >
      {PHASE_LABELS[phase]}
    </span>
  );
}

// ─── PacketsTab ───────────────────────────────────────────────────────────────

function PacketsTab({ data }: { data: TestData | null }) {
  if (!data) {
    return <div style={styles.empty}>No test data. Click Generate to create a test sequence.</div>;
  }
  const { enriched } = data;
  const base = enriched.chunks[0]?.chunk.timestamp ?? 0;

  return (
    <div style={styles.tabContent}>
      <div style={styles.summaryRow}>
        <Stat label="Chunks" value={enriched.chunks.length} />
        <Stat label="Cols" value={data.env.cols} />
        <Stat label="Rows" value={data.env.rows} />
        <Stat label="Scrollback" value={data.env.scrollbackLines} />
        <Stat label="Seed" value={data.env.seed} />
      </div>
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              {['Seq', 'Time', 'Bytes', 'Logical Lines', 'Content Preview'].map(h => (
                <th key={h} style={styles.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {enriched.chunks.map(({ chunk, expectedLines }) => {
              const logLines = expectedLines.map(e => e.logicalLine).join(', ') || '—';
              const preview = decoder.decode(chunk.data).slice(0, 40).replace(/[\x00-\x1f]/g, '·');
              return (
                <tr key={chunk.seq} data-testid="packet-row">
                  <td style={styles.td}>{chunk.seq}</td>
                  <td style={styles.td}>{fmtTime(chunk.timestamp - base)}</td>
                  <td style={styles.td}>{fmtBytes(chunk.data.length)}</td>
                  <td style={styles.td}>{logLines}</td>
                  <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 11 }}>{preview}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── SimulationTab ────────────────────────────────────────────────────────────

function SimulationTab({ data }: { data: TestData | null }) {
  if (!data) {
    return <div style={styles.empty}>No simulation data yet.</div>;
  }
  const { report } = data;

  return (
    <div style={styles.tabContent}>
      <div style={styles.summaryRow}>
        <Stat label="Buffer Rows" value={report.virtualBuffer.length} />
        <Stat label="Tagged Rows" value={report.virtualBuffer.filter(r => r.logicalLine !== null).length} />
        <Stat label="Scrolled Off" value={report.totalScrolledOff} />
        <Stat label="Cursor Row" value={report.finalCursorRow} />
        <Stat label="Cursor Col" value={report.finalCursorCol} />
      </div>
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              {['AbsRow', 'L#', 'Owner', 'Wrapped', 'Content'].map(h => (
                <th key={h} style={styles.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.virtualBuffer.map((row, i) => {
              const absRow = report.totalScrolledOff + i;
              const isTagged = row.logicalLine !== null;
              return (
                <tr key={absRow} data-testid="sim-row" style={isTagged ? {} : { opacity: 0.45 }}>
                  <td style={styles.td}>{absRow}</td>
                  <td style={styles.td}>{row.logicalLine ?? '—'}</td>
                  <td style={styles.td}>{row.ownerSeq ?? '—'}</td>
                  <td style={styles.td}>{row.isWrapped ? 'wrap' : ''}</td>
                  <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 11 }}>
                    {row.content.slice(0, 50).replace(/[\x00-\x1f]/g, '·')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── ValidationTab ────────────────────────────────────────────────────────────

function ValidationTab({ result }: { result: PlaybackValidationReport | null }) {
  if (!result) {
    return <div style={styles.empty}>Run validation after writing to the terminal.</div>;
  }
  const allPass = result.failures.length === 0;

  return (
    <div style={styles.tabContent}>
      <div
        data-testid="validation-summary"
        style={{
          ...styles.validationBanner,
          background: allPass ? '#14532d' : '#7f1d1d',
        }}
      >
        {allPass
          ? `✓ All ${result.matchedRows} / ${result.totalRows} rows matched`
          : `✗ ${result.failures.length} failure${result.failures.length > 1 ? 's' : ''} — ${result.matchedRows} / ${result.totalRows} rows matched`}
      </div>

      {result.failures.length > 0 && (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                {['Buffer Row', 'Expected (predicted)', 'Actual (xterm)'].map(h => (
                  <th key={h} style={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.failures.map((f, i) => (
                <tr key={i} data-testid="validation-failure">
                  <td style={styles.td}>{f.bufferRow}</td>
                  <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 11, color: '#86efac' }}>
                    {f.predicted}
                  </td>
                  <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 11, color: '#fca5a5' }}>
                    {f.actual ?? 'null (line not found)'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── DetailsPane ─────────────────────────────────────────────────────────────

interface DetailsPaneProps {
  activeTab: Tab;
  onTabChange: (t: Tab) => void;
  data: TestData | null;
  validation: PlaybackValidationReport | null;
}

function DetailsPane({ activeTab, onTabChange, data, validation }: DetailsPaneProps) {
  return (
    <div style={styles.detailsPane}>
      <div style={styles.tabBar}>
        {(['packets', 'simulation', 'validation'] as Tab[]).map(t => (
          <button
            key={t}
            data-testid={`tab-${t}`}
            onClick={() => onTabChange(t)}
            style={{
              ...styles.tabBtn,
              ...(activeTab === t ? styles.tabBtnActive : {}),
            }}
          >
            {TAB_LABELS[t]}
            {t === 'validation' && validation && (
              <span style={{
                marginLeft: 6,
                color: validation.failures.length === 0 ? '#86efac' : '#fca5a5',
              }}>
                {validation.failures.length === 0
                  ? `✓${validation.matchedRows}`
                  : `✗${validation.failures.length}`}
              </span>
            )}
            {t === 'packets' && data && (
              <span style={{ marginLeft: 6, color: '#94a3b8' }}>{data.enriched.chunks.length}</span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'packets'    && <PacketsTab data={data} />}
      {activeTab === 'simulation' && <SimulationTab data={data} />}
      {activeTab === 'validation' && <ValidationTab result={validation} />}
    </div>
  );
}

// ─── Stat pill ───────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={styles.stat}>
      <span style={styles.statLabel}>{label}</span>
      <span style={styles.statValue}>{value}</span>
    </div>
  );
}

// ─── TestHarness (main) ───────────────────────────────────────────────────────

export function TestHarness() {
  const [scenarioKey, setScenarioKey] = useState('stress-50');
  const [seed, setSeed] = useState(42);
  const [phase, setPhase] = useState<Phase>('idle');
  const [testData, setTestData] = useState<TestData | null>(null);
  const [validation, setValidation] = useState<PlaybackValidationReport | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('packets');
  const [comments, setComments] = useState<Map<number, string>>(new Map());
  const termContainerRef = useRef<HTMLDivElement>(null);
  const termWrapperRef   = useRef<HTMLDivElement>(null);
  const { termRef, adapterRef, harnessRef, termState, adapterState } = useXtermSetup(termContainerRef, {
    cols: 80, rows: 24,
    fontFamily: '"Cascadia Code", "Fira Code", Menlo, monospace',
    fontSize: 14,
    theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' },
    scrollback: 400,
    allowProposedApi: true,
  });
  const [selectionCtx, setSelectionCtx] = useState<SelectionContext | null>(null);
  const selectionCtxRef = useRef<SelectionContext | null>(null);
  selectionCtxRef.current = selectionCtx;
  const handleCommentChangeRef = useRef<(bufferRow: number, text: string) => void>(() => {});
  // pendingAutoRun holds data that should be played on the terminal after the
  // next React commit — deferred so the 'generated' phase renders first.
  const [pendingAutoRun, setPendingAutoRun] = useState<TestData | null>(null);

  // Collect all packet coords from the current enriched sequence
  const allCoords = useMemo<ExpectedLineCoord[]>(() => {
    if (!testData) return [];
    return testData.enriched.chunks.flatMap(ec => ec.expectedLines);
  }, [testData]);

  // Scroll sync — recomputes StreamMetrics on every xterm scroll event
  const scrollMetrics = useScrollSync(termState, adapterState, allCoords);

  // Harness-specific wiring — runs once after the terminal mounts
  useEffect(() => {
    const term    = termRef.current;
    const harness = harnessRef.current;
    if (!term || !harness) return;
    (window as unknown as Record<string, unknown>).__ptyTerm = term;
    const toolbar = new XtermToolbar();
    toolbar.loadBuiltIns({ onCommentChange: (row, text) => handleCommentChangeRef.current(row, text) });
    harness.addSelectionToolbar(toolbar);
    harness.onSelectionChange = ctx => setSelectionCtx(ctx);
    harness.enableEcho();
    term.write('\x1b[1;34mpty-sync harness\x1b[0m — type freely, or Generate + Run to replay a scenario\r\n$ ');
    return () => {
      setSelectionCtx(null);
      delete (window as unknown as Record<string, unknown>).__ptyTerm;
    };
  }, [termState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Generation counter: each new run increments this. If another run starts
  // while we're awaiting chunk writes, the old run detects the mismatch and exits.
  const runGenRef = useRef(0);

  // Extracted so both handleGenerate (with fresh data) and handleRun (re-run)
  // can share the same write logic without going through stale state.
  const runTestData = useCallback(async (data: TestData) => {
    if (!termRef.current) return;
    const term = termRef.current;
    const myGen = ++runGenRef.current;

    setPhase('running');
    term.options.scrollback = data.env.scrollbackLines;
    term.reset();

    // Write each chunk, await xterm's internal processing callback.
    // crLfify converts bare \n → \r\n so xterm's cursor resets to col 0,
    // matching VirtualTerminal's implicit-CR-on-LF behaviour.
    for (const { chunk } of data.enriched.chunks) {
      if (runGenRef.current !== myGen) return;  // superseded by a newer run
      await writeToXterm(term, chunk.data);
    }

    if (runGenRef.current !== myGen) return;
    adapterRef.current?.setEvictionOffset(data.report.totalScrolledOff);
    term.write('\r\n$ ');
    setPhase('ran');
    setActiveTab('simulation');
  }, []);

  // After generate, auto-run is deferred via state so the 'generated' phase
  // renders first (React batches synchronous updates, so we need a separate commit).
  useEffect(() => {
    if (!pendingAutoRun) return;
    setPendingAutoRun(null);
    void runTestData(pendingAutoRun);
  }, [pendingAutoRun, runTestData]);

  const handleGenerate = useCallback(() => {
    const def = PREDEFINED_SCENARIOS[scenarioKey];
    const envWithSeed = { ...def.env, seed };

    termRef.current?.resize(def.env.cols, def.env.rows);

    const { enriched, report } = generateScenarioSequence(seed, envWithSeed, def.scenarios);
    const data: TestData = { enriched, report, env: envWithSeed };

    setTestData(data);
    setValidation(null);
    setComments(new Map());
    setPhase('generated');
    setActiveTab('packets');
    // Enqueue auto-run — fires after React commits the 'generated' phase
    setPendingAutoRun(data);
  }, [scenarioKey, seed]);

  const handleRun = useCallback(async () => {
    if (!testData) return;
    await runTestData(testData);
  }, [testData, runTestData]);

  // Auto-generate the default scenario once the terminal is ready on first mount.
  const hasAutoLoadedRef = useRef(false);
  useEffect(() => {
    if (!termState || hasAutoLoadedRef.current) return;
    hasAutoLoadedRef.current = true;
    handleGenerate();
  }, [termState, handleGenerate]);

  const handleValidate = useCallback(() => {
    if (!testData || !adapterRef.current) return;
    const result = validateReport(testData.report, adapterRef.current);
    setValidation(result);
    setPhase('validated');
    setActiveTab('validation');
  }, [testData]);

  const handleCommentChange = useCallback((bufferRow: number, text: string) => {
    setComments(prev => {
      const next = new Map(prev);
      if (text) next.set(bufferRow, text);
      else next.delete(bufferRow);
      return next;
    });
  }, []);
  handleCommentChangeRef.current = handleCommentChange;

  // Sync xterm decorations whenever the comments map changes.
  // Rebuilds all markers so the amber tab appears on every commented row.
  useEffect(() => {
    if (!harnessRef.current || !adapterState) return;
    harnessRef.current.syncCommentDecorations(comments, adapterState.getEvictionOffset());
  }, [comments, adapterState]);

  // Dismiss selection toolbar when clicking outside the terminal wrapper.
  // Use 'click' (not 'mousedown') so that onBlur-triggered commits fire first.
  // Browser order: mousedown → blur → mouseup → click.
  // Guard: if e.target was detached by React's re-render (e.g. button swap → input),
  // document.contains returns false for the detached node — treat that as "inside".
  // Registered once on mount ([] deps); selectionCtxRef keeps the current value in sync.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!selectionCtxRef.current) return;
      const target = e.target as Node;
      if (!document.contains(target)) return; // detached by React re-render — ignore
      if (termWrapperRef.current && !termWrapperRef.current.contains(target)) {
        setSelectionCtx(null);
      }
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectionToolbar = harnessRef.current?.getToolbar() ?? null;

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <span style={styles.headerTitle}>pty-sync Test Harness</span>
        {testData && (
          <span style={styles.headerEnv}>
            {testData.env.cols}×{testData.env.rows} · {PREDEFINED_SCENARIOS[scenarioKey]?.label}
          </span>
        )}
      </header>

      <ControlBar
        scenarioKey={scenarioKey}
        onScenarioChange={setScenarioKey}
        seed={seed}
        onSeedChange={setSeed}
        phase={phase}
        onGenerate={handleGenerate}
        onRun={handleRun}
        onValidate={handleValidate}
      />

      <div style={styles.mainArea}>
        <div style={styles.terminalPane}>
          <div style={styles.terminalLabel}>xterm.js Terminal</div>
          {/* Horizontally scrollable so the strip is never clipped */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, overflowX: 'auto' }}>
            {/* Terminal + selection toolbar */}
            <div ref={termWrapperRef} style={{ position: 'relative' }}>
              <div
                data-testid="terminal-container"
                ref={termContainerRef}
                style={styles.terminalContainer}
              />
              {selectionCtx && selectionToolbar && adapterState && (
                <SelectionToolbar
                  ctx={selectionCtx}
                  toolbar={selectionToolbar}
                  adapter={adapterState}
                  onDismiss={() => setSelectionCtx(null)}
                />
              )}
            </div>

            {/* Custom xterm scrollbar — replaces the native unclickable one */}
            {scrollMetrics && adapterState && (
              <XtermScrollbar metrics={scrollMetrics} adapter={adapterState} />
            )}

            {/* Scroll indicator strip — only when we have live metrics */}
            {scrollMetrics && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {/* Column titles */}
                <div style={{ display: 'flex', gap: 4 }}>
                  {[
                    { label: 'buf',     width: 18, title: 'Buffer position — shows where the current viewport is within the full xterm scrollback buffer (dot = scroll fraction)' },
                    { label: 'time',    width: 18, title: 'Time position — shows where the current viewport aligns on the packet timeline (dot = time fraction of the visible center row)' },
                    { label: 'map',     width: 28, title: 'Stream map — each pixel row is one buffer row; colour = packet density. Click to jump the terminal to that position.' },
                    { label: 'comment', width: 32, title: 'Comments — one cell per terminal row. Orange = has comment. Click a cell to add or edit a note for that row.' },
                  ].map(({ label, width, title }) => (
                    <div key={label} title={title} style={{ cursor: 'help',
                      width,
                      flexShrink: 0,
                      textAlign: 'center',
                      fontSize: 9,
                      color: '#484f58',
                      textTransform: 'uppercase' as const,
                      letterSpacing: '0.05em',
                      overflow: 'hidden',
                    }}>
                      {label}
                    </div>
                  ))}
                </div>

                {/* The four data columns */}
                <div
                  data-testid="scroll-strip"
                  style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}
                >
                  <ScrollPointerCol metrics={scrollMetrics} mode="buffer" />
                  {adapterState && (
                    <TimeScaleCol metrics={scrollMetrics} adapter={adapterState} />
                  )}
                  {adapterState && (
                    <StreamMapCanvas
                      metrics={scrollMetrics}
                      adapter={adapterState}
                      comments={comments}
                    />
                  )}
                  <CommentCol
                    metrics={scrollMetrics}
                    comments={comments}
                    onCommentChange={handleCommentChange}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <DetailsPane
          activeTab={activeTab}
          onTabChange={setActiveTab}
          data={testData}
          validation={validation}
        />
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100vh',
    background: '#0a0a0f',
    color: '#c9d1d9',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: 13,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '8px 16px',
    background: '#161b22',
    borderBottom: '1px solid #30363d',
    flexShrink: 0,
  },
  headerTitle: {
    fontWeight: 600,
    color: '#58a6ff',
    fontSize: 14,
  },
  headerEnv: {
    color: '#8b949e',
    fontSize: 12,
  },
  controlBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 16px',
    background: '#161b22',
    borderBottom: '1px solid #30363d',
    flexShrink: 0,
    flexWrap: 'wrap' as const,
  },
  controlGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    color: '#8b949e',
    fontSize: 12,
    whiteSpace: 'nowrap' as const,
  },
  select: {
    background: '#21262d',
    color: '#c9d1d9',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 12,
    cursor: 'pointer',
    minWidth: 200,
  },
  input: {
    background: '#21262d',
    color: '#c9d1d9',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 12,
    outline: 'none',
  },
  controlSep: {
    width: 1,
    height: 24,
    background: '#30363d',
    margin: '0 4px',
  },
  btn: {
    padding: '5px 14px',
    borderRadius: 4,
    border: '1px solid #30363d',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    transition: 'opacity 0.15s',
  },
  btnPrimary: {
    background: '#1f6feb',
    color: '#fff',
    border: '1px solid #388bfd',
  },
  btnSecondary: {
    background: '#21262d',
    color: '#c9d1d9',
  },
  btnSuccess: {
    background: '#238636',
    color: '#fff',
    border: '1px solid #2ea043',
  },
  btnDisabled: {
    background: '#161b22',
    color: '#484f58',
    cursor: 'not-allowed',
  },
  badge: {
    padding: '3px 10px',
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 600,
    color: '#fff',
    marginLeft: 4,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  mainArea: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  terminalPane: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    padding: 12,
    background: '#0d1117',
    minWidth: 0,
  },
  terminalLabel: {
    fontSize: 11,
    color: '#484f58',
    marginBottom: 6,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
  },
  terminalContainer: {
    flex: '0 0 auto',
  },
  detailsPane: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: '0 0 420px',
    borderLeft: '1px solid #30363d',
    overflow: 'hidden',
  },
  tabBar: {
    display: 'flex',
    borderBottom: '1px solid #30363d',
    background: '#161b22',
    flexShrink: 0,
  },
  tabBtn: {
    padding: '8px 18px',
    background: 'transparent',
    color: '#8b949e',
    border: 'none',
    borderBottom: '2px solid transparent',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
  },
  tabBtnActive: {
    color: '#58a6ff',
    borderBottom: '2px solid #58a6ff',
  },
  tabContent: {
    flex: 1,
    overflow: 'auto',
    padding: 12,
  },
  summaryRow: {
    display: 'flex',
    gap: 8,
    marginBottom: 12,
    flexWrap: 'wrap' as const,
  },
  stat: {
    display: 'flex',
    flexDirection: 'column' as const,
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 6,
    padding: '6px 12px',
    minWidth: 60,
  },
  statLabel: {
    fontSize: 10,
    color: '#8b949e',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  statValue: {
    fontSize: 18,
    fontWeight: 700,
    color: '#c9d1d9',
    fontVariantNumeric: 'tabular-nums',
  },
  tableWrap: {
    overflowX: 'auto' as const,
    borderRadius: 6,
    border: '1px solid #30363d',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 12,
  },
  th: {
    textAlign: 'left' as const,
    padding: '6px 10px',
    background: '#161b22',
    color: '#8b949e',
    fontWeight: 600,
    fontSize: 11,
    textTransform: 'uppercase' as const,
    borderBottom: '1px solid #30363d',
    whiteSpace: 'nowrap' as const,
  },
  td: {
    padding: '5px 10px',
    borderBottom: '1px solid #21262d',
    color: '#c9d1d9',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    maxWidth: 300,
    textOverflow: 'ellipsis',
  },
  empty: {
    padding: 24,
    color: '#484f58',
    textAlign: 'center' as const,
    fontSize: 13,
  },
  validationBanner: {
    padding: '12px 16px',
    borderRadius: 6,
    color: '#fff',
    fontWeight: 600,
    fontSize: 14,
    marginBottom: 12,
  },
};
