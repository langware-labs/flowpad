/**
 * Derive `AttentionItem[]` for the top banner.
 *
 * Sources, in priority order:
 *  1. `feedback.md` present  → ALWAYS surfaces an attention item (the
 *     learner explicitly surrendered to the user, this is the loudest
 *     possible signal).
 *  2. Cross-run pattern: any step with ATTENTION-tier issues that persist
 *     across ≥2 of the selected runs.
 *  3. Latest-run attention: an ATTENTION-tier issue on the active run
 *     even if it's new this cycle.
 *
 * Each item carries a stable `id` so the per-session dismissal hook can
 * remember "I've seen this one".
 */

import { SeverityTier } from '@sdk/models/severity';

import type { AttentionItem, RunViewModel } from '../types';

const PERSIST_THRESHOLD = 2; // appears in ≥N runs to count as "persistent"
const HEADLINE_MAX_LEN = 120;

function truncate(s: string, n = HEADLINE_MAX_LEN): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

export function deriveAttention(
  runs: RunViewModel[],
  feedback?: { content: string } | null,
): AttentionItem[] {
  const out: AttentionItem[] = [];

  // (1) Feedback.md → top attention.
  if (feedback?.content?.trim()) {
    const firstLine = feedback.content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    out.push({
      id: 'feedback',
      tier: SeverityTier.ATTENTION,
      headline: 'Workflow needs human change',
      detail: feedback.content,
      reason: firstLine ? truncate(firstLine) : undefined,
    });
  }

  if (runs.length === 0) return out;

  // Index: line → how many runs show ATTENTION-tier issues there, plus the
  // most descriptive message we've seen for that line.
  type Slot = {
    line: number;
    step_text: string;
    runHits: Set<string>;
    headline?: string;
    detail?: string;
  };
  const byLine = new Map<number, Slot>();

  for (const run of runs) {
    for (const step of run.steps) {
      if (step.worstTier !== SeverityTier.ATTENTION) continue;
      const slot = byLine.get(step.line) ?? {
        line: step.line,
        step_text: step.step_text,
        runHits: new Set<string>(),
      };
      slot.runHits.add(run.processId);
      const primary = step.issues.find((i) => i.tier === SeverityTier.ATTENTION);
      if (primary && !slot.headline) {
        slot.headline = truncate(primary.message);
        slot.detail = primary.message;
      }
      byLine.set(step.line, slot);
    }
  }

  const activeId = runs[0]?.processId;

  for (const slot of byLine.values()) {
    const hits = slot.runHits.size;
    const isOnActive = activeId ? slot.runHits.has(activeId) : true;
    if (hits >= PERSIST_THRESHOLD || isOnActive) {
      out.push({
        id: `line:${slot.line}`,
        tier: SeverityTier.ATTENTION,
        headline:
          slot.headline ||
          `Step "${truncate(slot.step_text, 50)}" needs attention`,
        detail: slot.detail,
        anchor: { line: slot.line },
        reason:
          hits >= PERSIST_THRESHOLD
            ? `${hits} runs in a row`
            : 'failing this run',
      });
    }
  }

  return out;
}
