/** canonicalProcessDockPath — see the source JSDoc for the canonical-family rule. */
import { describe, expect, it } from 'vitest';
import { canonicalProcessDockPath } from '@src/navigation/process-dock-canonicalization';

const PROC = 'agentic_process-37c47bb1-f010-45e2-8ed9-fcad8901f7da';
const VIBE = `?scope-mode=project&viewMode=vibe`;
const STD = `?scope-mode=project&viewMode=standard`;

describe('canonicalProcessDockPath', () => {
  it('vibe: legacy shell process URL canonicalizes to the display URL', () => {
    expect(canonicalProcessDockPath(`/dock/shell/${PROC}`, VIBE)).toBe(
      `/dock/display/${PROC}${VIBE}`,
    );
  });

  it('vibe: display URL is already canonical', () => {
    expect(canonicalProcessDockPath(`/dock/display/${PROC}`, VIBE)).toBeNull();
  });

  it('standard: display URL canonicalizes to the shell URL', () => {
    expect(canonicalProcessDockPath(`/dock/display/${PROC}`, STD)).toBe(
      `/dock/shell/${PROC}${STD}`,
    );
  });

  it('viewMode absent falls back to the preference argument', () => {
    // Standard preference (default): display bounces, shell stays.
    expect(canonicalProcessDockPath(`/dock/display/${PROC}`, '')).toBe(`/dock/shell/${PROC}`);
    expect(canonicalProcessDockPath(`/dock/shell/${PROC}`, '')).toBeNull();
    // Vibe preference: the param-less legacy bookmark still reaches the display.
    expect(canonicalProcessDockPath(`/dock/shell/${PROC}`, '', true)).toBe(
      `/dock/display/${PROC}`,
    );
    expect(canonicalProcessDockPath(`/dock/display/${PROC}`, '', true)).toBeNull();
  });

  it('explicit param outranks the preference argument', () => {
    expect(canonicalProcessDockPath(`/dock/display/${PROC}`, STD, true)).toBe(
      `/dock/shell/${PROC}${STD}`,
    );
  });

  it('standard: shell process URL is already canonical', () => {
    expect(canonicalProcessDockPath(`/dock/shell/${PROC}`, STD)).toBeNull();
  });

  it('bare shell (terminal) pointers are never redirected, either mode', () => {
    expect(canonicalProcessDockPath('/dock/shell/shell-abc123', VIBE)).toBeNull();
    expect(canonicalProcessDockPath('/dock/shell/new_terminal', VIBE)).toBeNull();
  });

  it('non-process routes are untouched', () => {
    expect(canonicalProcessDockPath(`/dock/assets/editor/agent/typeid/agent-x`, VIBE)).toBeNull();
    expect(canonicalProcessDockPath('/dock/home', VIBE)).toBeNull();
  });

  it('win layout keeps its segment', () => {
    expect(canonicalProcessDockPath(`/win/shell/${PROC}`, VIBE)).toBe(
      `/win/display/${PROC}${VIBE}`,
    );
  });
});
