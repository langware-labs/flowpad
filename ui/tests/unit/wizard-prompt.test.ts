/**
 * buildWizardPrompt — the presentation flag that tells a wizard agent whether
 * it's running headless (WizardButton, must self-close) or in an interactive
 * popup (the user closes it). This is the seam that makes "never close" apply
 * only in popup mode.
 */
import { describe, it, expect } from 'vitest';
import { buildWizardPrompt } from '@sdk';

const req = { wizardName: 'task-analyze', wizardData: { prompt: 'Analyze it', payload: { taskId: 't1' } } };

describe('buildWizardPrompt', () => {
  it('marks a headless run as headless and requires the agent to close itself', () => {
    const out = buildWizardPrompt('proc-1', req, { headless: true });
    expect(out).toContain('Presentation: headless');
    expect(out).toMatch(/MUST close the wizard yourself/i);
    // The close command + the user's prompt/payload are still present.
    expect(out).toContain('flow wizard proc-1 close');
    expect(out).toContain('Analyze it');
    expect(out).toContain('"taskId": "t1"');
  });

  it('marks a popup run as interactive (agent may wait for the user)', () => {
    const out = buildWizardPrompt('proc-1', req, { headless: false });
    expect(out).toContain('Presentation: interactive popup');
    expect(out).not.toContain('Presentation: headless');
  });

  it('defaults to popup (non-headless) when no options are passed', () => {
    const out = buildWizardPrompt('proc-1', req);
    expect(out).toContain('Presentation: interactive popup');
  });
});
