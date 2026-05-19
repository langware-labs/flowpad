/**
 * Scan a workflow .md source string for the line numbers of `## Steps`
 * bullets. Used to resolve "step N" anchors emitted by older analyzer
 * skill builds and to populate StepViewModel.step_text.
 */
export function extractStepLines(source: string): number[] {
  const out: number[] = [];
  let inSteps = false;
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s === '## Steps') {
      inSteps = true;
      continue;
    }
    if (inSteps && s.startsWith('## ')) break;
    // Tolerate `- ` and `* ` and `+ ` bullets (linter sometimes rewrites them).
    if (inSteps && /^[-*+]\s/.test(s)) out.push(i + 1);
  }
  return out;
}

/** Return both the 1-indexed line and the raw step text for each bullet. */
export function extractSteps(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let inSteps = false;
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s === '## Steps') {
      inSteps = true;
      continue;
    }
    if (inSteps && s.startsWith('## ')) break;
    const m = s.match(/^[-*+]\s+(.*)$/);
    if (inSteps && m) out.push({ line: i + 1, text: m[1].trim() });
  }
  return out;
}
