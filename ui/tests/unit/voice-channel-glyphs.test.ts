/**
 * A voice channel's glyph is an asset fact: each voice driver names its own glyph for channel
 * `voice` in its manifest (`channel_icon_names`), and those names are real lucide glyphs — a typo
 * would silently draw the generic fallback on every voice conversation.
 */
import { describe, expect, it } from 'vitest';
import { DataDriver } from '@sdk';
import { sourceIconName } from '@src/components/data-sources/source-icon';
import { lucideByName } from '@src/lib/lucide-by-name';
import browser from '../../../flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/voice_browser/data_driver.json';
import file from '../../../flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/voice_file/data_driver.json';
import phone from '../../../flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/voice_phone/data_driver.json';

const MANIFESTS = [browser, file, phone];

describe('voice channel glyphs', () => {
  it.each(MANIFESTS.map((m) => [m.name, m]))('%s names a real glyph for channel voice, and says how a call starts', (_name, manifest) => {
    // The file says `schema`; the row says `manifest_schema` (`schema` is the entity's own getter).
    const { schema: manifest_schema, ...row } = manifest;
    const spec = new DataDriver({ ...row, manifest_schema } as never);
    const glyph = sourceIconName(spec, 'voice');
    expect(glyph).toBeTruthy();
    expect(lucideByName(glyph)).not.toBe(lucideByName('not-a-lucide-glyph-at-all'));
    expect(['webrtc', 'clip', 'dial']).toContain(spec.calls);
  });

  it('every way of starting a call is offered by exactly one shipped voice driver', () => {
    expect(MANIFESTS.map((m) => m.calls).sort()).toEqual(['clip', 'dial', 'webrtc']);
  });
});
