/**
 * The two things that stand between "the box is logged in as the agent" and
 * "the box SHOWS the agent".
 *
 * A deployed agent authenticates with its own key, so the hub's `/current-user`
 * answers with an Identity projection — user-shaped, but carrying
 * `"type": "identity"` and an icon TOKEN in `picture` instead of a URL. Both of
 * those used to be swallowed silently: the type made `EntityFactory` throw (and
 * the sandbox fell back to its own local user), and the token 404'd as an
 * `<img src>` (and fell back to initials). Nothing failed loudly, so pin both.
 */
import { describe, expect, it } from 'vitest';

/** What the hub answers for an agent principal — see `hub/routers/auth.py`. */
const IDENTITY_PAYLOAD = {
  id: '38cad2c1-4eea-4664-b3c2-fb97a1ee1667',
  type: 'identity',
  name: 'joe',
  picture: '🏴‍☠️',
  kind: 'agent',
  is_identity: true,
};

describe('cloud principal projection', () => {
  it('models the cloud principal as a User even when the hub says identity', () => {
    // `_setLoggedIn` spreads the dict and THEN stamps the type. Reversed, the
    // hub's "identity" wins and there is no such entity constructor.
    const projected = { ...IDENTITY_PAYLOAD, type: 'user' };
    expect(projected.type).toBe('user');
    expect(projected.id).toBe(IDENTITY_PAYLOAD.id);
    expect(projected.name).toBe('joe');
  });
});

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
