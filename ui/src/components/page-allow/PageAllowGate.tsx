import { Trans, useLingui } from '@lingui/react/macro';
import { PrefKey } from '@sdk';
import { Button } from '@src/components/ui/button';
import { usePreference } from '@src/hooks/use-preference';
import { errorMessage } from '@src/lib/error-message';
import { mintPageKey, probePageKey } from './probe-page-key';
import { STATE_KEY_PARAM } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

/** What a page was opened about, as its state key says (`flow_sdk/schema/data_spec/page_state_spec.py`). */
export type PageContext = Record<string, string>;

type Access = { status: 'checking' } | { status: 'ok'; context: PageContext } | { status: 'ask' };

/**
 * Whether the page this dock names may run: the local server asks for a key (`enforced`) and the dock
 * carries one it minted (`probed`). A server that asks for none lets everything run; a key the server
 * does not know — expired, or from another computer — asks again like no key at all.
 */
/** Keys the server already vouched for: a warm return to their page renders at once and asks the backend nothing. */
const vouched = new Map<string, Access>();

function usePageAccess(
  dockKey: string | undefined,
  reaskToken: number,
  installed: boolean,
  enabled: boolean,
): Access {
  const [access, setAccess] = useState<Access>(() => (dockKey && vouched.get(dockKey)) || { status: 'checking' });
  useEffect(() => {
    // No dock: the gate runs its page as is, so there is nothing to ask the server.
    if (!enabled) return;
    const known = dockKey ? vouched.get(dockKey) : undefined;
    if (known) {
      setAccess(known);
      return;
    }
    let live = true;
    setAccess({ status: 'checking' });
    void probePageKey(dockKey)
      .then(({ enforced, probed }) => {
        if (!live) return;
        if (probed) {
          const ok: Access = { status: 'ok', context: probed.context ?? {} };
          if (dockKey) vouched.set(dockKey, ok);
          setAccess(ok);
        } else setAccess(enforced ? { status: 'ask' } : { status: 'ok', context: {} });
      })
      // A server that cannot be asked fails closed for a file, and open for an installed app (which then says why itself).
      .catch(() => live && setAccess(installed ? { status: 'ok', context: {} } : { status: 'ask' }));
    return () => {
      live = false;
    };
  }, [dockKey, reaskToken, installed, enabled]);
  return access;
}

/**
 * Runs a page only with a state key. A page its opener minted a key for (`flow show`, an agent) opens
 * straight away; a link from outside carries none, so THIS asks the user first — in the page's own place,
 * before anything of it mounts, and never as a toast. Allow mints a key and writes it into the address
 * (so a reload keeps it); "Always allow this page" remembers the page.
 *
 * `installed`: the address names an installed app (an entity, not an arbitrary file), so there is nothing to ask
 * — the key is minted silently and written into the address the same way. One rule for which docks ask, one
 * place that mints; a server that cannot be asked leaves the app to say why itself.
 */
export function PageAllowGate({
  title,
  installed = false,
  children,
}: {
  title: string;
  installed?: boolean;
  children: (page: { stateKey: string | undefined; context: PageContext }) => ReactNode;
}) {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();
  const dockKey = currentDock?.options?.[STATE_KEY_PARAM];
  // The session whose display this page is shown in, when the address names one; a key's own context covers the rest.
  const flowId = currentDock?.hostProcessId;
  const pageId = `${currentDock?.viewType}|${currentDock?.pointer}`;
  const [trusted, setTrusted] = usePreference<string[] | null>(PrefKey.PAGE_TRUST);
  const [reask, setReask] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const access = usePageAccess(dockKey, reask, installed, !!currentDock);

  const allow = useCallback(
    async (always: boolean) => {
      if (!currentDock) return;
      try {
        const key = await mintPageKey(title, flowId);
        if (always) setTrusted([...(trusted ?? []), pageId]);
        navigation.replaceDock(currentDock.withOption(STATE_KEY_PARAM, key));
        setReask((n) => n + 1);
      } catch (error) {
        setFailure(errorMessage(error, t`Could not allow this page.`));
      }
    },
    [currentDock, flowId, navigation, pageId, setTrusted, t, title, trusted],
  );

  // An installed app, or a page the user chose to always allow, runs without asking.
  const autoAllowed = useRef(false);
  const silent = installed || !!trusted?.includes(pageId);
  useEffect(() => {
    if (access.status === 'ask' && silent && !denied && !autoAllowed.current) {
      autoAllowed.current = true;
      void allow(false);
    }
    if (access.status === 'ok') autoAllowed.current = false;
  }, [access.status, silent, denied, allow]);

  if (!currentDock || (installed && failure)) return <>{children({ stateKey: dockKey, context: {} })}</>;
  if (access.status === 'ok') return <>{children({ stateKey: dockKey, context: access.context })}</>;
  if (access.status === 'checking' || (silent && !denied && !failure)) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t`Loading preview…`}</div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="page-allow-card">
      <div className="max-w-md space-y-3 rounded-lg border bg-card p-5 text-card-foreground shadow-sm">
        <h2 className="text-base font-semibold" data-testid="page-allow-title">
          <Trans>Allow “{title}” to run in Flowpad?</Trans>
        </h2>
        <p className="text-sm text-muted-foreground">
          {denied ? (
            <Trans>It has not run. A page can read and change what Flowpad holds, so run only pages you trust.</Trans>
          ) : (
            <Trans>
              This page was opened by a link, not by Flowpad. Once it runs it can read and change what Flowpad holds,
              so allow it only if you trust where it came from.
            </Trans>
          )}
        </p>
        {failure && (
          <p className="text-sm text-destructive" data-testid="page-allow-error">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void allow(false)} data-testid="page-allow-accept">
            <Trans>Allow</Trans>
          </Button>
          <Button variant="outline" onClick={() => void allow(true)} data-testid="page-allow-always">
            <Trans>Always allow this page</Trans>
          </Button>
          {!denied && (
            <Button variant="ghost" onClick={() => setDenied(true)} data-testid="page-allow-deny">
              <Trans>Don’t allow</Trans>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
