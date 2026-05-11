import type { AnchoredItem, IssueMark } from '@src/components/anchored-markdown';

interface AnalysisRecord {
  anchor?: string | number | { line?: number; file?: string };
  status?: string;
  issues?: Array<{ kind?: string; note?: string; detail?: string; severity?: string }>;
}

/**
 * Map analysis records (one per anchor) to per-line issue chips.
 *
 * Anchor formats supported:
 *   - bare number: 12
 *   - "L12"
 *   - "step <n>" → resolved via stepLineMap (caller passes a list of step lines)
 */
export function reduceAnalysis(jsonl: string, stepLines: number[] = []): AnchoredItem<IssueMark>[] {
  const records = jsonl
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as AnalysisRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is AnalysisRecord => !!r && Array.isArray(r.issues));

  const out: AnchoredItem<IssueMark>[] = [];
  for (const rec of records) {
    const line = parseAnchor(rec.anchor, stepLines);
    if (line == null) continue;
    let idx = 0;
    for (const issue of rec.issues ?? []) {
      out.push({
        id: `analysis:${line}:${idx++}`,
        anchor: { line },
        data: {
          kind: issue.kind || 'issue',
          note: issue.note || issue.detail || '',
          severity: normalizeSeverity(issue.severity ?? issue.kind),
        },
      });
    }
  }
  return out;
}

function parseAnchor(raw: unknown, stepLines: number[]): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'object') {
    const line = (raw as { line?: unknown }).line;
    return typeof line === 'number' && Number.isFinite(line) ? line : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const num = Number(trimmed);
  if (Number.isFinite(num)) return num;
  const lMatch = trimmed.match(/^L(\d+)$/i);
  if (lMatch) return Number(lMatch[1]);
  const stepMatch = trimmed.match(/^step\s+(\d+)$/i);
  if (stepMatch) {
    const idx = Number(stepMatch[1]) - 1;
    return stepLines[idx] ?? null;
  }
  return null;
}

function normalizeSeverity(sev: unknown): IssueMark['severity'] {
  if (sev === 'error') return 'error';
  if (sev === 'warn' || sev === 'warning') return 'warn';
  // The analyzer's `kind` doubles as severity hint for issue types like
  // "retry", "wrong_tool", "repeated_work" — treat as warn (amber chip).
  if (typeof sev === 'string' && sev) return 'warn';
  return 'info';
}

/**
 * Helper: scan workflow markdown source for the line numbers of `- ` bullets
 * under `## Steps`, used to resolve "step N" anchors.
 */
export function extractStepLines(source: string): number[] {
  const out: number[] = [];
  let inSteps = false;
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s === '## Steps') { inSteps = true; continue; }
    if (inSteps && s.startsWith('## ')) break;
    if (inSteps && s.startsWith('- ')) out.push(i + 1);
  }
  return out;
}
