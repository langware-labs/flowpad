import { cloudManager, dataContext, dataManager, QueryRequest, User } from '@sdk';
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

function cloudLocalUser(): LocalUser | null {
  const cloudUser = cloudManager.currentUser;
  if (!cloudManager.isLoggedIn || !cloudUser?.id) return null;
  return {
    id: cloudUser.id ?? '',
    name: cloudUser.name ?? cloudUser.email ?? '',
  };
}

async function fetchFromBackend(): Promise<LocalUser | null> {
  const cloud = cloudLocalUser();
  if (cloud) return cloud;
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

// The local user is a single global value, so subscribe to cloud auth changes
// ONCE at module scope (not once per hook instance). Previously every
// useLocalUser() consumer added its own login_complete/logout_complete
// listener to the cloudManager singleton — N bubbles meant N identical
// listeners, tripping MaxListenersExceededWarning. The shared `_listeners` Set
// already fans state to all hooks; this keeps the emitter at one listener each.
let _authSubscribed = false;

function ensureAuthSubscription(): void {
  if (_authSubscribed) return;
  _authSubscribed = true;
  const refresh = () => {
    _loading = null;
    if (!cloudManager.isLoggedIn) _current = null;
    void ensureLoaded();
  };
  cloudManager.on('login_complete', refresh);
  cloudManager.on('logout_complete', refresh);
}

function ensureLoaded(): Promise<LocalUser | null> {
  const cloud = cloudLocalUser();
  if (cloud) {
    if (_current?.id !== cloud.id || _current?.name !== cloud.name) {
      _current = cloud;
      notify();
    }
    return Promise.resolve(_current);
  }
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
    ensureAuthSubscription();
    _listeners.add(setLocalUser);
    void ensureLoaded();
    return () => {
      _listeners.delete(setLocalUser);
    };
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
