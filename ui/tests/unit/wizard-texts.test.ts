/**
 * The words a wizard's run shows that the BACKEND wrote, in Hebrew and Arabic.
 *
 * They live in asset files (wizard.json, a compute op), so no `<Trans>` can wrap them:
 * `wizard-texts.ts` maps each one. Loaded from the real catalogs, so a string that was added to the
 * table but never translated fails here instead of showing up in English in a Hebrew app.
 */
import { setupI18n, type I18n } from '@lingui/core';
import { describe, expect, it } from 'vitest';

import { backendText, rungWord } from '@src/components/assets/editor/wizard/wizard-texts';
import { messages as ar } from '../../src/locales/ar/messages.po';
import { messages as he } from '../../src/locales/he/messages.po';

const make = (locale: string, messages: Record<string, unknown>): I18n =>
  setupI18n({ locale, messages: { [locale]: messages as never } });

const LANGS: Array<[string, I18n]> = [
  ['he', make('he', he)],
  ['ar', make('ar', ar)],
];

const FIXED = [
  'Finish setting up Flowpad',
  'Setup finished — everything is installed.',
  "Setup didn't finish successfully.",
  'Restart setup',
  "It doesn't appear to be installed on your computer. Would you like to install it now?",
  "It doesn't appear to be installed on your computer. Would you like to install it now? On a Mac, Apple's installer opens in its own window — if you don't see it, look behind this one.",
  'Install',
  'Skip',
  'working',
  'finishing',
  'waiting for you',
  'starting the agent',
];

describe.each(LANGS)('backend-written wizard text in %s', (_code, i18n) => {
  it.each(FIXED)('translates %j', (text) => {
    const out = backendText(i18n, text);
    expect(out).not.toBe(text);
    expect(out.length).toBeGreaterThan(0);
  });

  it('rebuilds a sentence around a tool name, leaving the name as it is', () => {
    for (const text of [
      'Claude Code is required to continue',
      'Install Node.js?',
      'checking Git',
      'Git: waiting for you…',
    ]) {
      const out = backendText(i18n, text);
      expect(out).not.toBe(text);
      expect(out).toContain(text.match(/Claude Code|Node\.js|Git/)![0]);
    }
  });

  it('translates the rung a step is on, inside a progress line', () => {
    const out = backendText(i18n, 'Python 3: cli');
    expect(out).toContain('Python 3');
    expect(out).not.toContain('cli');
    expect(rungWord(i18n, 'agent')).not.toBe('agent');
  });

  it('shows a text it does not know exactly as the backend wrote it', () => {
    expect(backendText(i18n, 'Some wizard nobody translated yet')).toBe('Some wizard nobody translated yet');
  });
});
