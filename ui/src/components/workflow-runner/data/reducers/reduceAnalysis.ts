/**
 * Parse workflow.analysis.jsonl → per-line normalized issue list.
 *
 * Tolerates the three schemas we observed across cycles 1-4:
 *   - cycle 1: rec.issue (singular string) + rec.severity = blocker/derived/info
 *   - cycle 2-3: rec.issues = [{ severity: error/warn/info, message, category }]
 *   - cycle 4: rec.issues = [{ type, description, severity: high/medium/low }]
 *
 * All severity tokens collapse to SeverityTier via classifySeverity.
 */

import { classifySeverity, SeverityTier } from '@sdk/models/severity';

import type {
  AnalysisIssue,
  AnalysisRecord,
  NormalizedIssue,
} from '../../data/types';

export interface AnalysisByLine {
  line: number;
  step_text?: string;
  issues: NormalizedIssue[];
  recommendation?: string;
  /** Worst tier across this anchor's issues, for the gutter chip color. */
  worstTier?: SeverityTier;
}

function parseRecords(jsonl: string): AnalysisRecord[] {
  return jsonl
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as AnalysisRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is AnalysisRecord => !!r);
}

function resolveAnchorLine(
  raw: unknown,
  stepLines: number[],
): number | null {
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

function normalizeIssue(
  raw: AnalysisIssue | string,
  recordLevelSeverity?: string,
): NormalizedIssue {
  if (typeof raw === 'string') {
    return {
      tier: classifySeverity(recordLevelSeverity),
      message: raw,
      rawSeverity: recordLevelSeverity ?? undefined,
    };
  }
  const message =
    raw.message ||
    raw.description ||
    raw.detail ||
    (typeof raw.kind === 'string' ? raw.kind : '') ||
    (typeof raw.type === 'string' ? raw.type : '') ||
    'issue';
  // `kind` and `type` are aliases — keep the canonical `kind` field on the
  // normalized issue so downstream consumers don't have to care.
  return {
    tier: classifySeverity(raw.severity, raw.kind ?? raw.type, raw.category),
    message,
    kind: raw.kind ?? raw.type,
    category: raw.category,
    rawSeverity: raw.severity,
    threshold_ms: raw.threshold_ms,
    actual_ms: raw.actual_ms,
  };
}

function worstOf(items: NormalizedIssue[]): SeverityTier | undefined {
  if (items.length === 0) return undefined;
  if (items.some((i) => i.tier === SeverityTier.ATTENTION))
    return SeverityTier.ATTENTION;
  if (items.some((i) => i.tier === SeverityTier.NOTABLE))
    return SeverityTier.NOTABLE;
  return SeverityTier.INFO;
}

export function reduceAnalysis(
  jsonl: string,
  stepLines: number[] = [],
): AnalysisByLine[] {
  const records = parseRecords(jsonl);
  const byLine = new Map<number, AnalysisByLine>();

  for (const rec of records) {
    const line = resolveAnchorLine(rec.anchor, stepLines);
    if (line == null) continue;

    let bucket = byLine.get(line);
    if (!bucket) {
      bucket = {
        line,
        step_text: rec.step_text || rec.step,
        issues: [],
        recommendation: rec.recommendation ?? undefined,
      };
      byLine.set(line, bucket);
    }
    if (!bucket.step_text && (rec.step_text || rec.step)) {
      bucket.step_text = rec.step_text || rec.step;
    }
    if (!bucket.recommendation && rec.recommendation) {
      bucket.recommendation = rec.recommendation;
    }

    if (Array.isArray(rec.issues) && rec.issues.length > 0) {
      for (const iss of rec.issues) {
        bucket.issues.push(normalizeIssue(iss, rec.severity));
      }
    } else if (rec.issue != null) {
      bucket.issues.push(normalizeIssue(rec.issue, rec.severity));
    }
  }

  for (const bucket of byLine.values()) {
    bucket.worstTier = worstOf(bucket.issues);
  }

  return Array.from(byLine.values()).sort((a, b) => a.line - b.line);
}
