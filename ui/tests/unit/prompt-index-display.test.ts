import { describe, expect, it } from 'vitest';
import {
  promptDisplayText,
  slashCommandText,
} from '@src/components/terminal/interactive-terminal/side-windows/promptDisplay';

/**
 * Claude Code writes a typed slash command as TWO user rows — the tag envelope
 * the human typed, then an `is_meta` row carrying the expanded SKILL.md. Both
 * are stored on purpose; the Prompts index just has to read the right one.
 */
const COMMAND_ENVELOPE =
  '<command-message>rca</command-message>\n' +
  '<command-name>/rca</command-name>\n' +
  '<command-args>Closing the tab keeps reopening it</command-args>';

const SKILL_BODY =
  'Base directory for this skill: /repo/.claude/skills/rca\n\n' +
  '# RCA — Root Cause Analyzer\n\nFind why something fails, prove it, and stop.';

describe('promptDisplayText', () => {
  it('renders a typed slash command as the command, not the envelope', () => {
    expect(promptDisplayText(COMMAND_ENVELOPE, false)).toBe('/rca Closing the tab keeps reopening it');
  });

  it('skips the expanded skill body the harness injects after it', () => {
    expect(promptDisplayText(SKILL_BODY, true)).toBeNull();
  });

  it('keeps a bare slash command with no args', () => {
    expect(slashCommandText('<command-name>/rca</command-name>')).toBe('/rca');
  });

  it('keeps ordinary typed text untouched', () => {
    expect(promptDisplayText('why does the tab reopen?', false)).toBe('why does the tab reopen?');
  });

  it('leaves other harness XML rows alone so the SYS badge still catches them', () => {
    const notification = '<task-notification>\n<task-id>abc</task-id>\n</task-notification>';
    expect(promptDisplayText(notification, false)).toBe(notification);
  });

  it('surfaces the human tail of a Flowpad embedded-agent wrapper', () => {
    // is_meta, but the human turn is buried inside — dropping it would empty
    // the index for every headless vibe session.
    const wrapper = "# You are the 'vibe' agent\nInternal routing instructions.\n\n# User message\nOpen the app";
    expect(promptDisplayText(wrapper, true)).toBe('Open the app');
  });

  it('drops blank rows', () => {
    expect(promptDisplayText('   \n  ', false)).toBeNull();
  });

  it('does not mistake prose that merely mentions the tags for a command', () => {
    const prose = 'the index shows <command-name>/rca</command-name> instead of the skill';
    expect(promptDisplayText(prose, false)).toBe(prose);
  });
});
