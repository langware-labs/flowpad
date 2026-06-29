import { detectLanguage, isImagePath } from '@sdk';
import { describe, expect, it } from 'vitest';

/**
 * Regression: opening an image file from a conversation's Shared Context (the
 * "Open" action → editor dock, e.g.
 *   compute_node-@local/var/folders/.../flow_message/<uuid>/data/image (4).png
 * ) showed the raw binary bytes instead of the picture.
 *
 * Root cause: the editor decides how to render a file purely from its path.
 * `detectLanguage` returns 'plaintext' for image extensions (Monaco has no
 * image language), so the file fell through to the Monaco text editor and its
 * bytes were decoded as UTF-8 text. `isImagePath` is the on/off switch that
 * gates inline <img> rendering in EditorPane (`const isImage = isImagePath(...)`).
 * When it returns false the file goes to the text editor — the bug.
 */
describe('editor image rendering decision', () => {
  it('recognizes the reported image file as an image (so it is NOT routed to the text editor)', () => {
    // The exact file from the bug report — note the space and parenthesis.
    expect(isImagePath('image (4).png')).toBe(true);
  });

  it('recognizes an image at the full compute_node-@local VFS path', () => {
    const vfsPath =
      'compute_node-@local/var/folders/zd/fj0rydsd3jg0p_fxc95hym800000gn/T/flow-embedded-storage/flow_message/eec388d0-e4b0-4035-8143-e7ce1e9de9b7/data/image (4).png';
    expect(isImagePath(vfsPath)).toBe(true);
  });

  it('documents why the bug happened: detectLanguage gives images no image-aware language', () => {
    // detectLanguage falling back to 'plaintext' is exactly why the bytes hit
    // Monaco as text — isImagePath is the only signal that prevents that.
    expect(detectLanguage('image (4).png')).toBe('plaintext');
  });

  it('recognizes the common image extensions', () => {
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg', 'a.avif', 'a.bmp', 'a.ico']) {
      expect(isImagePath(name)).toBe(true);
    }
  });

  it('does not treat text/code/extensionless files as images', () => {
    for (const name of ['notes.txt', 'script.py', 'README.md', 'data.json', 'Dockerfile', 'noext']) {
      expect(isImagePath(name)).toBe(false);
    }
  });
});
