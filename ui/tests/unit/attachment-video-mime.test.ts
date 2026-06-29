/**
 * AttachmentChip video <source> MIME typing.
 *
 * `.mov` is the QuickTime container but ISO-BMFF like `.mp4`; Chrome/Chromium
 * rejects `type="video/quicktime"` (`canPlayType` returns '') yet plays an
 * H.264/AAC `.mov` when the source is labeled `video/mp4`. So the preview must
 * NEVER emit `video/quicktime` — that's what dropped `.mov` previews to a file
 * icon. (Chrome guidance: don't use `type=video/quicktime` for `.mov`.)
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { videoSource } from '@src/components/conversation/AttachmentChip';

const typeOf = (name: string): string | undefined =>
  (videoSource('blob:x', name) as ReactElement<{ type?: string }>).props.type;

describe('AttachmentChip videoSource', () => {
  it('labels .mov as video/mp4 (NOT video/quicktime) so Chrome will play it', () => {
    expect(typeOf('Screen Recording.mov')).toBe('video/mp4');
  });

  it('keeps the other recognised containers correct', () => {
    expect(typeOf('clip.mp4')).toBe('video/mp4');
    expect(typeOf('clip.m4v')).toBe('video/mp4');
    expect(typeOf('clip.webm')).toBe('video/webm');
  });

  it('never emits the unplayable video/quicktime label', () => {
    for (const n of ['a.mov', 'b.MOV', 'c.mp4', 'd.webm']) {
      expect(typeOf(n)).not.toBe('video/quicktime');
    }
  });

  it('omits the type for an unrecognised extension (let the browser sniff)', () => {
    expect(typeOf('clip.avi')).toBeUndefined();
  });
});
