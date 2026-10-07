/** The three-step glyph rule shared by the card, the stream inbox chip and the channels bar. */
import { describe, expect, it } from 'vitest';
import { sourceGlyphs, sourceIconName } from '@src/components/data-sources/source-icon';
import { lucideByName } from '@src/lib/lucide-by-name';

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

describe('sourceGlyphs', () => {
  it("badges the channel's mark with whose way it is (Flow in a channel's group)", () => {
    const flow = { icon_name: 'Flowpad', channel_icon_names: {}, group_icon_name: 'WhatsApp' };
    const { Base, Badge } = sourceGlyphs(flow, 'whatsapp');
    expect(Base).toBe(lucideByName('WhatsApp'));
    expect(Badge).toBe(lucideByName('Flowpad'));
  });
  it('leaves a driver whose own glyph IS the group glyph plain (your own bot)', () => {
    const own = { icon_name: 'WhatsApp', channel_icon_names: {}, group_icon_name: 'WhatsApp' };
    expect(sourceGlyphs(own, 'whatsapp')).toEqual({ Base: lucideByName('WhatsApp'), Badge: null });
    expect(sourceGlyphs(agentSpec, 'gmail')).toEqual({ Base: lucideByName('Mail'), Badge: null });
  });
});
