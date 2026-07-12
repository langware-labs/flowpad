/** canonicalProcessDockPath — see the source JSDoc for the canonical-family rule.
 *
 * One URL family per process (`/dock/shell/...`) in BOTH view modes: vibe is a
 * rendering mode carried by `?viewMode`, never a URL family. The canonicalizer
 * is now purely legacy back-compat — any `display` URL redirects to the shell
 * form with its search preserved verbatim; shell URLs are never redirected. */
import { describe, expect, it } from 'vitest';
import { canonicalProcessDockPath } from '@src/navigation/process-dock-canonicalization';
import { ViewType } from '@src/types/ViewType';

const PROC = 'agentic_process-37c47bb1-f010-45e2-8ed9-fcad8901f7da';
const VIBE = `?scope-mode=project&viewMode=vibe`;
const STD = `?scope-mode=project&viewMode=standard`;

describe('canonicalProcessDockPath', () => {
  it('legacy display URL redirects to the shell URL, search preserved verbatim', () => {
    expect(canonicalProcessDockPath(`/dock/display/${PROC}`, STD)).toBe(`/dock/shell/${PROC}${STD}`);
    expect(canonicalProcessDockPath(`/dock/display/${PROC}`, VIBE)).toBe(`/dock/shell/${PROC}${VIBE}`);
    expect(canonicalProcessDockPath(`/dock/display/${PROC}`, '')).toBe(`/dock/shell/${PROC}`);
  });

  it('shell process URLs are never redirected — either mode param, or none', () => {
    expect(canonicalProcessDockPath(`/dock/shell/${PROC}`, VIBE)).toBeNull();
    expect(canonicalProcessDockPath(`/dock/shell/${PROC}`, STD)).toBeNull();
    expect(canonicalProcessDockPath(`/dock/shell/${PROC}`, '')).toBeNull();
  });

  it('win layout keeps its segment', () => {
    expect(canonicalProcessDockPath(`/win/display/${PROC}`, VIBE)).toBe(`/win/shell/${PROC}${VIBE}`);
    expect(canonicalProcessDockPath(`/win/shell/${PROC}`, VIBE)).toBeNull();
  });

  it('bare shell (terminal) pointers are never redirected', () => {
    expect(canonicalProcessDockPath('/dock/shell/shell-abc123', VIBE)).toBeNull();
    expect(canonicalProcessDockPath('/dock/shell/new_terminal', VIBE)).toBeNull();
  });

  it('a display URL with a non-process pointer is not redirected', () => {
    expect(canonicalProcessDockPath('/dock/display/shell-abc123', VIBE)).toBeNull();
  });

  it('non-process routes are untouched', () => {
    expect(canonicalProcessDockPath(`/dock/assets/editor/agent/typeid/agent-x`, VIBE)).toBeNull();
    expect(canonicalProcessDockPath('/dock/home', VIBE)).toBeNull();
  });

  it('the DISPLAY view type is gone from the registry (identity fully retired)', () => {
    // The display tab identity was eliminated (one tab per process); the enum
    // member's removal is what auto-rejects /dock/display for anything the
    // legacy redirect above doesn't cover.
    expect(Object.values(ViewType)).not.toContain('display');
  });
});
