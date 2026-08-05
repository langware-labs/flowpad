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
    const pointer = credentialsPointer(CredentialsSubview.ENVIRONMENT, 'proj-1');

    expect(pointer).toBe('environment/proj-1');
    expect(parseCredentialsPointer(pointer)).toEqual({
      tab: CredentialsSubview.ENVIRONMENT,
      projectId: 'proj-1',
    });
  });

  it('falls back to the tab the caller nominates, never a blank pane', () => {
    for (const p of [undefined, '', 'not-a-tab', '/']) {
      expect(parseCredentialsPointer(p, CredentialsSubview.CONNECTIONS).tab).toBe(CredentialsSubview.CONNECTIONS);
      expect(parseCredentialsPointer(p).tab).toBe(CredentialsSubview.ENVIRONMENT);
    }
  });

  it('leads with Connections on a hub, Environment on the desk', () => {
    // Environment is project-scoped and the hub routinely has no project, so
    // leading with it opened the view on an empty state.
    expect(credentialsTabs(true)[0]).toBe(CredentialsSubview.CONNECTIONS);
    expect(credentialsTabs(false)[0]).toBe(CredentialsSubview.ENVIRONMENT);
    // API Keys stays last either way — only the first two swap.
    expect(credentialsTabs(true).at(-1)).toBe(CredentialsSubview.API_KEYS);
    expect(credentialsTabs(false).at(-1)).toBe(CredentialsSubview.API_KEYS);
  });

  it('omits the project segment when there is no project', () => {
    expect(credentialsPointer(CredentialsSubview.API_KEYS)).toBe('api-keys');
    expect(parseCredentialsPointer('api-keys').projectId).toBeUndefined();
  });

  it('keeps the api-keys tab id intact despite its hyphen', () => {
    // 'api-keys' must not be mistaken for two segments.
    expect(parseCredentialsPointer('api-keys/proj-9')).toEqual({
      tab: CredentialsSubview.API_KEYS,
      projectId: 'proj-9',
    });
  });
});
