/** The three-step glyph rule shared by the card, the inbox chip and the channels bar. */
import { describe, expect, it } from 'vitest';
import { sourceIconName } from '@src/components/data-sources/source-icon';

const agentSpec = { icon_name: 'Bot', channel_icon_names: { gmail: 'Mail', slack: 'Slack' } };

describe('sourceIconName', () => {
  it('prefers the channel glyph of a multi-channel transport', () => {
    expect(sourceIconName(agentSpec, 'gmail')).toBe('Mail');
  });
  it('falls back to the spec glyph for an unnamed channel — or no channel yet', () => {
    expect(sourceIconName(agentSpec, 'telegram')).toBe('Bot');
    expect(sourceIconName(agentSpec, '')).toBe('Bot');
  });
  it('answers empty when nothing is installed, so the caller picks its generic glyph', () => {
    expect(sourceIconName(undefined, 'slack')).toBe('');
  });
});
