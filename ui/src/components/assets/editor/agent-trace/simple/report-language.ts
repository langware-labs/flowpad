/**
 * Plain-language translation for the simple session report — turns the
 * trace's analysis jargon (verdicts, severities, "divergences") into wording a
 * non-technical user understands.
 *
 * Pure / React-free on purpose, so it's covered by a no-mock unit test (mirrors
 * the `analysis-improvements.ts` style). The report component computes nothing.
 */
import { t } from '@lingui/core/macro';
import type { AgentTraceDoc, TraceFinding } from '../trace-types';

/** Tone drives the tint — reuses the same palette key as `verdictStyle`. */
export type Tone = 'ok' | 'mixed' | 'bad' | 'neutral';

export interface FriendlyVerdict {
  emoji: string;
  headline: string;
  /** The model's own one-line reason, plain. Empty when none. */
  reason: string;
  tone: Tone;
}

/** ok/mixed/bad/none → a friendly headline + emoji + the model's reason line. */
export function friendlyVerdict(
  verdict?: string | null,
  reason?: string | null,
): FriendlyVerdict {
  const v = (verdict ?? '').toLowerCase();
  const plainReason = (reason ?? '').trim();
  switch (v) {
    case 'ok':
      return { emoji: '🟢', headline: 'Looks good — it did what you asked.', reason: plainReason, tone: 'ok' };
    case 'mixed':
      return { emoji: '🟡', headline: "Mostly fine — a few things could've gone better.", reason: plainReason, tone: 'mixed' };
    case 'bad':
      return { emoji: '🔴', headline: 'Ran into trouble — several things went wrong.', reason: plainReason, tone: 'bad' };
    default:
      return { emoji: '⚪', headline: 'Not rated yet.', reason: plainReason, tone: 'neutral' };
  }
}

export interface FriendlySeverity {
  label: string;
  tone: Tone;
}

/** A finding's severity → a soft, plain chip. */
export function friendlySeverity(severity?: string | null): FriendlySeverity {
  switch ((severity ?? '').toLowerCase()) {
    case 'attention':
      return { label: t`Needs a look`, tone: 'bad' };
    case 'warn':
    case 'warning':
      return { label: t`Minor`, tone: 'mixed' };
    default:
      return { label: t`Note`, tone: 'neutral' };
  }
}

/** A finding's kind → everyday words. */
export function friendlyKind(kind?: string | null): string {
  switch ((kind ?? '').toLowerCase()) {
    case 'divergence':
      return "Didn't follow its instructions";
    case 'issue':
      return 'Problem';
    default:
      return 'Note';
  }
}

export interface ReportIssue {
  /** The skill this came from, or undefined for session-level findings. */
  skillName?: string;
  title: string;
  detail?: string;
  severity?: string;
  kind: string;
  /** How many identical findings were collapsed into this row (≥1). */
  count: number;
}

/**
 * Every problem the analysis recorded, flattened + de-duplicated for the "What
 * to look at" list. The same trace can carry its findings in any of three
 * places depending on how it was analyzed, so we read the richest available
 * source (and only that one, to avoid double-counting):
 *
 *   1. `annotations.by_skill` + `unattributed` — the curated, skill-attributed
 *      bucket a skillit analysis writes (tagged with the skill name).
 *   2. `markers` (kind issue/divergence) — the complete granular set a plain
 *      session analysis writes; matches the headline issue/divergence counts.
 *   3. `annotations.divergences` + `issues` — older docs without markers.
 *
 * Identical findings (same kind + wording) are collapsed to one row with a
 * `count`, so a run that failed the same edit four times reads "×4" rather than
 * four near-identical lines — the counts still sum to the headline.
 */
export function flattenIssues(doc: AgentTraceDoc | null): ReportIssue[] {
  if (!doc) return [];
  const ann = doc.annotations ?? ({} as AgentTraceDoc['annotations']);

  // 1. Curated per-skill findings.
  const curated: ReportIssue[] = [];
  for (const bucket of Object.values(ann.by_skill ?? {})) {
    for (const f of bucket.findings ?? []) curated.push(fromFinding(f, bucket.skill));
  }
  for (const f of ann.unattributed ?? []) curated.push(fromFinding(f, undefined));
  if (curated.length) return dedupe(curated);

  // 2. Granular markers (the complete set behind the headline counts).
  const fromMarkers: ReportIssue[] = (doc.markers ?? [])
    .filter((m) => m.kind === 'issue' || m.kind === 'divergence')
    .map((m) => ({ title: m.label, detail: m.detail, severity: m.severity, kind: m.kind, count: 1 }));
  if (fromMarkers.length) return dedupe(fromMarkers);

  // 3. Session-level annotation lists (older docs).
  const legacy: ReportIssue[] = [
    ...(ann.divergences ?? []).map((s) => fromSkillIssue(s, 'divergence')),
    ...(ann.issues ?? []).map((s) => fromSkillIssue(s, 'issue')),
  ];
  return dedupe(legacy);
}

function fromFinding(f: TraceFinding, skillName?: string): ReportIssue {
  return { skillName, title: f.label, detail: f.detail, severity: f.severity, kind: f.kind, count: 1 };
}

function fromSkillIssue(s: { label: string; detail?: string; severity?: string }, kind: string): ReportIssue {
  return { title: s.label, detail: s.detail, severity: s.severity, kind, count: 1 };
}

/** Collapse identical rows (same skill + kind + title), summing their counts. */
function dedupe(issues: ReportIssue[]): ReportIssue[] {
  const byKey = new Map<string, ReportIssue>();
  for (const issue of issues) {
    const key = `${issue.skillName ?? ''}|${issue.kind}|${issue.title}`;
    const existing = byKey.get(key);
    if (existing) existing.count += issue.count;
    else byKey.set(key, { ...issue });
  }
  return [...byKey.values()];
}

export interface SkillInvolved {
  name: string;
  issueCount: number;
}

/**
 * The skills the assistant used, with how many problems each had. Includes
 * skills with zero findings (they were still used) — sorted most-problems first.
 */
export function skillsInvolved(doc: AgentTraceDoc | null): SkillInvolved[] {
  const bySkill = doc?.annotations?.by_skill ?? {};
  return Object.values(bySkill)
    .map((b) => ({ name: b.skill, issueCount: b.findings?.length ?? 0 }))
    .sort((a, b) => b.issueCount - a.issueCount || a.name.localeCompare(b.name));
}

/** "1 problem" / "3 problems" — count-aware, plain. */
export function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
