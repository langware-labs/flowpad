import type { I18n, MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';

/**
 * The words a wizard's run shows that the BACKEND wrote: a wizard's title and messages (its
 * `wizard.json`), an install question (a compute op's prompt, detail and buttons), and the progress
 * line a running step reports ("checking Git", "Claude Code: cli").
 *
 * They are English strings in asset files, not components, so no `<Trans>` can wrap them. This is
 * the one place that maps each to its translation: an exact table for the fixed sentences, a few
 * patterns for the ones with a tool's name in them. Every `msg` below is found by `lingui extract`
 * like any other string. A text with no entry is shown as the backend wrote it — a new wizard works
 * untranslated until its words are added here.
 */
const EXACT: Record<string, MessageDescriptor> = {
  // llm-setup's own document
  'Finish setting up Flowpad': msg`Finish setting up Flowpad`,
  "Flowpad works best with a few tools on your machine: Claude Code, Python, Git and Node.js. We'll check what's already there and only ask before installing anything that's missing.": msg`Flowpad works best with a few tools on your machine: Claude Code, Python, Git and Node.js. We'll check what's already there and only ask before installing anything that's missing.`,
  'Setup finished — everything is installed.': msg`Setup finished — everything is installed.`,
  "Setup didn't finish successfully.": msg`Setup didn't finish successfully.`,
  'Restart setup': msg`Restart setup`,
  // an install question
  "It doesn't appear to be installed on your computer. Would you like to install it now?": msg`It doesn't appear to be installed on your computer. Would you like to install it now?`,
  "It doesn't appear to be installed on your computer. Would you like to install it now? On a Mac, Apple's installer opens in its own window — if you don't see it, look behind this one.": msg`It doesn't appear to be installed on your computer. Would you like to install it now? On a Mac, Apple's installer opens in its own window — if you don't see it, look behind this one.`,
  Install: msg`Install`,
  Skip: msg`Skip`,
  'Not now': msg`Not now`,
  'Search needs one Microsoft component': msg`Search needs one Microsoft component`,
  "Microsoft Visual C++ Runtime (about 25 MB, installed once for all apps) isn't on this computer. Windows will ask for permission to install it.": msg`Microsoft Visual C++ Runtime (about 25 MB, installed once for all apps) isn't on this computer. Windows will ask for permission to install it.`,
  // a step's progress line
  working: msg`working`,
  finishing: msg`finishing`,
  'waiting for you': msg`waiting for you`,
  'starting the agent': msg`starting the agent`,
  'waiting for you to choose an LLM source': msg`waiting for you to choose an LLM source`,
};

/** A sentence with a tool's name in it: matched, then rebuilt around the (untranslated) name. */
const PATTERNS: Array<[RegExp, (m: RegExpMatchArray, i18n: I18n) => string]> = [
  [/^(.+) is required to continue$/, (m, i18n) => i18n._(msg`${m[1]} is required to continue`)],
  [/^Install (.+)\?$/, (m, i18n) => i18n._(msg`Install ${m[1]}?`)],
  [/^checking (.+)$/, (m, i18n) => i18n._(msg`checking ${m[1]}`)],
  [/^(.+): waiting for you…$/, (m, i18n) => i18n._(msg`${m[1]}: waiting for you…`)],
  [/^(.+): agent, again$/, (m, i18n) => i18n._(msg`${m[1]}: agent, again`)],
  [/^(.+): (cli|agent|prompt|ask)$/, (m, i18n) => i18n._(msg`${m[1]}: ${rungWord(i18n, m[2])}`)],
  [/^(working|finishing) · (.+)$/, (m, i18n) => `${backendText(i18n, m[1])} · ${m[2]}`],
];

/** The three rungs a step can climb, as a person reads them. */
export function rungWord(i18n: I18n, rung: string): string {
  switch (rung) {
    case 'validation':
      return i18n._(msg`validation`);
    case 'cli':
      return i18n._(msg`command`);
    case 'agent':
      return i18n._(msg`agent`);
    case 'prompt':
      return i18n._(msg`prompt`);
    case 'ask':
      return i18n._(msg`question`);
    default:
      return rung;
  }
}

/** A backend-written text in the person's language; the text itself when nothing maps it. */
export function backendText(i18n: I18n, text: string): string {
  const exact = EXACT[text];
  if (exact) return i18n._(exact);
  for (const [re, build] of PATTERNS) {
    const m = text.match(re);
    if (m) return build(m, i18n);
  }
  return text;
}

/** `backendText` bound to the current language, for a component. */
export function useBackendText(): (text: string) => string {
  const { i18n } = useLingui();
  return (text) => backendText(i18n, text);
}
