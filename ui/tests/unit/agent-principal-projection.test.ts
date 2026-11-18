/**
 * A deployed agent's avatar is the icon TOKEN its Agent row was authored with (an emoji or a
 * lucide name), not a URL: fed to `<img src>` it 404s and falls back to initials. Pin the
 * discrimination. (That the box adopts the agent as an Identity is `cloud-manager-hub-identity`.)
 */
import { describe, expect, it } from 'vitest';

/** Mirrors the discrimination in `user-dropdown.tsx`. */
function classifyPicture(picture: string): 'url' | 'token' | 'initials' {
  if (/^(https?:|data:|\/)/.test(picture)) return 'url';
  if (picture && !/^[\w .-]+$/.test(picture)) return 'token';
  return 'initials';
}

describe('avatar source', () => {
  it.each([
    ['https://lh3.googleusercontent.com/a/x', 'url'],
    ['/static/me.png', 'url'],
    ['🏴‍☠️', 'token'],
    ['pirate', 'initials'], // a bare word is not a glyph — never draw it as one
    ['', 'initials'],
  ])('%s → %s', (picture, expected) => {
    expect(classifyPicture(picture)).toBe(expected);
  });
});
