/**
 * Plain-English "why this step's result is what it is" — for non-tech users.
 *
 * Renders the analyzer's primary description WITHOUT category/severity
 * jargon. If there's no analyzer signal, falls back to the trace detail.
 * If none, returns null (the parent decides whether to render a placeholder).
 *
 * Pure render.
 */

import { SeverityTier } from '@sdk/models/severity';

import type { NormalizedIssue, StepViewModel } from '../data/types';

interface PlainEnglishWhyProps {
  step: StepViewModel;
}

function pickPrimaryIssue(issues: NormalizedIssue[]): NormalizedIssue | undefined {
  // Prefer ATTENTION; otherwise NOTABLE; else the first.
  return (
    issues.find((i) => i.tier === SeverityTier.ATTENTION) ??
    issues.find((i) => i.tier === SeverityTier.NOTABLE) ??
    issues[0]
  );
}

export function PlainEnglishWhy({ step }: PlainEnglishWhyProps) {
  const primary = pickPrimaryIssue(step.issues);
  const message = primary?.message || step.detail;
  if (!message) return null;
  return (
    <div data-testid="plain-english-why">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Why
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">
        {message}
      </p>
      {step.recommendation && (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          <span className="text-foreground">Recommendation: </span>
          {step.recommendation}
        </p>
      )}
    </div>
  );
}
