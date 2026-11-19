import { Trans, useLingui } from '@lingui/react/macro';
import { PrefKey } from '@sdk';
import { Button } from '@src/components/ui/button';
import { usePreference } from '@src/hooks/use-preference';
import { stateKey } from '@sdk/page-state';
import { probePageKey, vouchedContext } from './probe-page-key';
import { STATE_KEY_PARAM } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

/** What a page was opened about, as its state key says (`flow_sdk/schema/data_spec/page_state_spec.py`). */
export type PageContext = Record<string, string>;

type Access = { status: 'checking' } | { status: 'ok'; context: PageContext } | { status: 'ask' };

/**
 * Whether the page this dock names may run: the local server asks for a key (`enforced`) and the dock
 * carries one it minted. A server that asks for none lets everything run; a key the server does not know
 * — expired, or from another computer — asks like no key at all. A key already vouched for answers at once.
 */
function usePageAccess(dockKey: string | undefined, enabled: boolean): Access {
  const [access, setAccess] = useState<Access>(() => {
    const context = vouchedContext(dockKey);
    return context ? { status: 'ok', context } : { status: 'checking' };
  });
  useEffect(() => {
    // No dock: the gate runs its page as is, so there is nothing to ask the server.
    if (!enabled) return;
    const context = vouchedContext(dockKey);
    if (context) {
      setAccess({ status: 'ok', context });
      return;
    }
    let live = true;
    setAccess({ status: 'checking' });
    void probePageKey(dockKey)
      .then(({ enforced, probed }) => {
        if (!live) return;
        if (probed) setAccess({ status: 'ok', context: probed.context ?? {} });
        else setAccess(enforced ? { status: 'ask' } : { status: 'ok', context: {} });
      })
      // A server that cannot be asked fails closed.
      .catch(() => live && setAccess({ status: 'ask' }));
    return () => {
      live = false;
    };
  }, [dockKey, enabled]);
  return access;
}

/**
 * Runs a page only on a dock that carries a key the local server knows. Every navigation made inside the
 * app carries the app's own key (`NavigationActions.openDock`) and a page an agent opened carries the one
 * it minted, so both open straight away. A link from outside carries none, so THIS asks the user first —
 * in the page's own place, before anything of it mounts, and never as a toast. Allow writes the app's key
 * into the address (so a reload keeps it); "Always allow this page" remembers the page. Nothing is minted
 * here: only an agent that opens a page with a context of its own mints.
 */
export function PageAllowGate({
  title,
  children,
}: {
  title: string;
  children: (page: { stateKey: string | undefined; context: PageContext }) => ReactNode;
}) {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();
  const dockKey = currentDock?.options?.[STATE_KEY_PARAM];
  const pageId = `${currentDock?.viewType}|${currentDock?.pointer}`;
  const [trusted, setTrusted] = usePreference<string[] | null>(PrefKey.PAGE_TRUST);
  const [denied, setDenied] = useState(false);
  const access = usePageAccess(dockKey, !!currentDock);

  const allow = useCallback(
    (always: boolean) => {
      const key = stateKey();
      if (!currentDock || !key) return;
      if (always) setTrusted([...(trusted ?? []), pageId]);
      navigation.replaceDock(currentDock.withOption(STATE_KEY_PARAM, key));
    },
    [currentDock, navigation, pageId, setTrusted, trusted],
  );

  // A page the user chose to always allow runs without asking.
  const silent = !!trusted?.includes(pageId);
  useEffect(() => {
    if (access.status === 'ask' && silent && !denied) allow(false);
  }, [access.status, silent, denied, allow]);

  if (!currentDock) return <>{children({ stateKey: dockKey, context: {} })}</>;
  if (access.status === 'ok') return <>{children({ stateKey: dockKey, context: access.context })}</>;
  if (access.status === 'checking' || (silent && !denied)) {
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
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => allow(false)} data-testid="page-allow-accept">
            <Trans>Allow</Trans>
          </Button>
          <Button variant="outline" onClick={() => allow(true)} data-testid="page-allow-always">
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
