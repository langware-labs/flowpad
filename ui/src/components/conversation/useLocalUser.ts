import { dataContext, dataManager, QueryRequest, User } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { useState, useEffect } from 'react';

export interface LocalUser {
  id: string;
  name: string;
}

// Shared store: all hook instances stay in sync, including after pencil edits
// in other parts of the UI.
let _current: LocalUser | null = null;
let _loading: Promise<LocalUser | null> | null = null;
const _listeners = new Set<(u: LocalUser | null) => void>();

function notify() {
  _listeners.forEach((cb) => cb(_current));
}

async function fetchFromBackend(): Promise<LocalUser | null> {
  // Match the backend convention: local user has uname === 'local'.
  // (User.isLocal checks the email domain, which doesn't match when git config sets a real email.)
  if (dataContext.user?.uname === 'local') {
    return { id: dataContext.user.id ?? '', name: (dataContext.user as any).name ?? '' };
  }
  try {
    const users = await dataManager.query(new QueryRequest({ type: User.type }));
    const local = (users as User[]).find((u) => u.uname === 'local');
    if (local) return { id: local.id ?? '', name: local.name ?? '' };
  } catch {
    // ignore
  }
  return null;
}

function ensureLoaded(): Promise<LocalUser | null> {
  if (_current !== null) return Promise.resolve(_current);
  if (_loading) return _loading;
  _loading = fetchFromBackend().then((u) => {
    _current = u;
    _loading = null;
    notify();
    return u;
  });
  return _loading;
}

export function useLocalUser(): { localUser: LocalUser | null; updateName: (name: string) => Promise<void> } {
  const [localUser, setLocalUser] = useState<LocalUser | null>(_current);

  useEffect(() => {
    _listeners.add(setLocalUser);
    void ensureLoaded();
    return () => { _listeners.delete(setLocalUser); };
  }, []);

  const updateName = async (name: string) => {
    const action = new ActionInfo('update-local-user-name', null, null, 'POST');
    action.bodyParameters = { name };
    await dataManager.callAction(action);
    _current = _current ? { ..._current, name } : { id: '', name };
    notify();
  };

  return { localUser, updateName };
}
