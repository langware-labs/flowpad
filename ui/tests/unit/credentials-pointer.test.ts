/**
 * The credentials pointer — tab and project both live in the URL, so this is
 * the whole of that view's navigation contract.
 */
import { describe, it, expect } from 'vitest';
import { CredentialsSubview } from '@sdk';

import {
  credentialsPointer,
  credentialsTabs,
  parseCredentialsPointer,
} from '@src/components/credentials-view/credentials-pointer';

describe('credentials pointer', () => {
  it('round-trips a tab', () => {
    expect(parseCredentialsPointer(credentialsPointer(CredentialsSubview.CONNECTIONS)).tab).toBe(
      CredentialsSubview.CONNECTIONS,
    );
  });

  it('round-trips a tab and a project', () => {
    const pointer = credentialsPointer(CredentialsSubview.CONNECTIONS, 'proj-1');

    expect(pointer).toBe('connections/proj-1');
    expect(parseCredentialsPointer(pointer)).toEqual({
      tab: CredentialsSubview.CONNECTIONS,
      projectId: 'proj-1',
    });
  });

  it('forwards a retired subview to Connections, keeping the project', () => {
    // `environment` and `api-keys` no longer render, but they remain in the
    // cross-language enum and every persisted Tab row is normalized through
    // this vocabulary — so they must resolve somewhere real rather than land on
    // a blank pane.
    for (const retired of ['environment', 'api-keys']) {
      expect(parseCredentialsPointer(`${retired}/proj-1`)).toEqual({
        tab: CredentialsSubview.CONNECTIONS,
        projectId: 'proj-1',
      });
    }
  });

  it('falls back to the tab the caller nominates, never a blank pane', () => {
    for (const p of [undefined, '', 'not-a-tab', '/']) {
      expect(parseCredentialsPointer(p, CredentialsSubview.CONNECTIONS).tab).toBe(CredentialsSubview.CONNECTIONS);
      expect(parseCredentialsPointer(p).tab).toBe(CredentialsSubview.CONNECTIONS);
    }
  });

  it('offers Connections and nothing else, on hub and desk alike', () => {
    // One surface: an OAuth provider, an API credential and a bare declared env
    // var are all rows in the same table, so Project Environment and API Keys
    // have nothing left to show that Connections does not.
    expect(credentialsTabs(true)).toEqual([CredentialsSubview.CONNECTIONS]);
    expect(credentialsTabs(false)).toEqual([CredentialsSubview.CONNECTIONS]);
  });

  it('omits the project segment when there is no project', () => {
    expect(credentialsPointer(CredentialsSubview.API_KEYS)).toBe('api-keys');
    expect(parseCredentialsPointer('api-keys').projectId).toBeUndefined();
  });

  it('keeps the api-keys id intact despite its hyphen', () => {
    // 'api-keys' must not be mistaken for two segments — the project still has
    // to survive the forward.
    expect(credentialsPointer(CredentialsSubview.API_KEYS)).toBe('api-keys');
    expect(parseCredentialsPointer('api-keys/proj-9')).toEqual({
      tab: CredentialsSubview.CONNECTIONS,
      projectId: 'proj-9',
    });
  });
});
