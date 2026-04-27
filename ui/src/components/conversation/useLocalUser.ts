import { dataContext, dataManager, QueryRequest, User } from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { useState, useEffect } from 'react';

export interface LocalUser {
  id: string;
  name: string;
}

// Module-level cache so we only query once per session
let _localUserPromise: Promise<LocalUser | null> | null = null;

function fetchLocalUser(): Promise<LocalUser | null> {
  if (_localUserPromise) return _localUserPromise;
  _localUserPromise = (async () => {
    // Match the backend: local user has uname === 'local'.
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
  })();
  return _localUserPromise;
}

export function useLocalUser(): { localUser: LocalUser | null; updateName: (name: string) => Promise<void> } {
  const [localUser, setLocalUser] = useState<LocalUser | null>(null);

  useEffect(() => {
    void fetchLocalUser().then(setLocalUser);
  }, []);

  const updateName = async (name: string) => {
    const action = new ActionInfo('update-local-user-name', null, null, 'POST');
    action.bodyParameters = { name };
    await dataManager.callAction(action);
    // Bust cache so the next call re-fetches
    _localUserPromise = null;
    setLocalUser((prev) => (prev ? { ...prev, name } : null));
  };

  return { localUser, updateName };
}
