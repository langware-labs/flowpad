/**
 * Assistants & keys — what can pay for a call, one line each.
 *
 * Every row answers ONE question with ONE word: what pays. Plan, API key, LLM Endpoint — or,
 * when nothing does, why not: Signed out, Not checked, Not installed. "Signed in" is implied by
 * Plan; the old row said both and they could disagree. The word comes from the same two records
 * the LLM sources page and the footer chip read (`useStatusRecord`, `useLlmSources`) through
 * `funding-pill.ts`, so the three surfaces cannot drift.
 *
 * The list is all this modal is. Signing in to an assistant is `HarnessSignInDialog`; the key
 * form and the hub endpoints are sections of LLM sources; "Details ›" on any row lands there,
 * focused on that row. Which MODEL each size runs is set on the endpoint itself (a device login
 * is an endpoint row of its own, under API keys), not here.
 */
import { i18n } from '@lingui/core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  capabilityManager,
  cloudManager,
  CapabilityKinds,
  HARNESS_CAPABILITY_KINDS,
  HubLogin,
  isQuietLoginError,
  llmSourcesService,
  statusService,
  type LLMFundingStatus,
  type StatusRecord,
} from '@sdk';
import { usePrimaryContentReady } from '@sdk/react/primary-content';
import { useCloudStatus } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, Cloud, KeyRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import flowpadIcon from '@src/assets/flowpad-icon.png';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@src/components/ui/dialog';
import { providerLabel } from '@src/components/llm-sources/provider-label';
import { openLlmSources } from '@src/components/llm-sources/llm-sources-pointer';
import { useHubRemaining } from '@src/components/llm-sources/use-hub-remaining';
import type { CostLeftByEndpoint } from '@src/components/llm-endpoints/usage-math';
import { useLlmSources } from '@src/components/llm-sources/use-llm-sources';
import { harnessStatus, refreshHarnessStatus, useStatusRecord } from '@src/components/status/use-status-record';
import { useAssistantWikiSpace } from '@src/components/wiki-tip/assistant-wiki';
import { WikiLabel } from '@src/components/wiki-tip/WikiLabel';
import { errorMessage } from '@src/lib/error-message';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

import {
  endpointsSummary,
  keysSummary,
  pillForFlowpad,
  pillForHarness,
  pillOf,
  type PillAction,
} from './funding-pill';
import { harnessVisual } from './harness-visual';
import { openHarnessLoginModal, useHarnessLoginStore } from './harness-login-store';
import { openHarnessSignIn } from './harness-sign-in-store';
import { FUNDING_WIKI_PAGE, StatusRow } from './StatusRow';

/**
 * localStorage flag that records the user has already seen + dismissed the
 * startup harness-login gate. Once set, the gate never auto-opens again — the
 * footer warning remains the (click-driven) path back in. Restored from the
 * retired DesktopSetupModal so a user (or test harness) can opt out of the nag.
 */
const HARNESS_GATE_SEEN_KEY = 'llm-setup-modal-seen';

function harnessGateDismissed(): boolean {
  try {
    return localStorage.getItem(HARNESS_GATE_SEEN_KEY) === 'true';
  } catch {
    return false;
  }
}

export function markHarnessGateSeen(): void {
  try {
    localStorage.setItem(HARNESS_GATE_SEEN_KEY, 'true');
  } catch {
    /* private-mode / storage-disabled — nag stays, which is acceptable */
  }
}

/**
 * Startup gate: auto-open only when the DEFAULT assistant has nothing to pay for its runs, and
 * the user hasn't already dismissed the gate. The answer is the funding layer's — after one
 * status refresh, so a login the boot sweep has not probed yet is decided rather than guessed.
 * Other assistants' gaps are the footer warning's job, which opens this modal on click.
 */
function useHarnessLoginGate() {
  const primaryReady = usePrimaryContentReady();
  const decided = useRef(false);
  useEffect(() => {
    if (!primaryReady || decided.current || harnessGateDismissed()) return;
    let cancelled = false;
    void (async () => {
      try {
        await statusService.refresh([...HARNESS_CAPABILITY_KINDS]);
        const funding = await llmSourcesService.status();
        decided.current = true;
        // The backend's own set-up verdict — the same answer `flow llm set auto` reads.
        if (!cancelled && funding && !funding.default.source) openHarnessLoginModal({ fresh: true });
      } catch {
        /* status unavailable — never block startup */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [primaryReady]);
}

/** The button label per action; `details` keeps the row's default "Details ›". */
const ACTION_LABEL: Record<PillAction, MessageDescriptor | null> = {
  sign_in: msg`Sign in`,
  add_key: msg`Add key`,
  details: null,
};

const actionLabel = (action: PillAction): string | undefined => {
  const label = ACTION_LABEL[action];
  return label ? i18n._(label) : undefined;
};

/** The two records every row reads, read ONCE by the dialog body and handed down. */
interface Facts {
  record: StatusRecord | null;
  funding: LLMFundingStatus | null;
  left: CostLeftByEndpoint;
}

/**
 * Leave the modal for a place that answers the row's question. A dialog left over the page it
 * just sent you to reads as a bug, so every exit closes it first. Going to LLM sources also
 * settles the startup gate (the person has seen what funds what); opening a sign-in does not —
 * that dialog's own Done does.
 */
function useExits() {
  const { navigation } = useDockNavigation();
  const { setOpen } = useHarnessLoginStore();
  return useMemo(
    () => ({
      toSources: (target: string | undefined) => {
        markHarnessGateSeen();
        setOpen(false);
        openLlmSources(navigation, target);
      },
      toSignIn: (kind: string) => {
        setOpen(false);
        openHarnessSignIn(kind);
      },
    }),
    [navigation, setOpen],
  );
}

/** A section header that is also a wikitip into the funding-states page. */
function SectionHeading({ fragment, label, hint }: { fragment: string; label: string; hint?: ReactNode }) {
  const space = useAssistantWikiSpace();
  return (
    <div className="mt-3 flex items-center justify-between px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      <WikiLabel wikiword={FUNDING_WIKI_PAGE} fragment={fragment} label={label} space={space} />
      {hint}
    </div>
  );
}

/**
 * FlowPad's own account, first in the list: it is the only row that asks the user for nothing
 * they do not already have — a new account is granted a hub endpoint, so signing in IS the
 * whole setup. Sign-in only: signing OUT of FlowPad has consequences far beyond this dialog.
 *
 * Connect is awaited HERE rather than routed through `useOAuthConnection`, for the reason
 * `flowpad-connection-row.tsx` documents: `flowpad_cloud` registers no OAuth flow, so
 * `OAUTH_FLOW_COMPLETE` never fires and the hook's only path for clearing its spinner never runs.
 */
function FlowpadRow({ record, funding, onConnected }: Omit<Facts, 'left'> & { onConnected: () => void }) {
  const { t } = useLingui();
  const { cloudUrl } = useCloudStatus();
  const exits = useExits();
  const [busy, setBusy] = useState(false);
  const { pill, email, funds } = pillForFlowpad(record, funding);
  const loggedIn = record?.hub.login === HubLogin.SignedIn;
  const signingIn = busy || record?.hub.login === HubLogin.SigningIn;

  // The OAuth-style flow this awaits can settle `login.status` a moment after its own promise
  // resolves — watching the FLIP (never on mount) catches it either way.
  const wasLoggedIn = useRef(loggedIn);
  useEffect(() => {
    if (loggedIn && !wasLoggedIn.current) onConnected();
    wasLoggedIn.current = loggedIn;
  }, [loggedIn, onConnected]);

  const connect = async () => {
    setBusy(true);
    try {
      await cloudManager.login();
    } catch (error) {
      // Cancel, or "Open the page again" starting a newer attempt: choices, not failures to report.
      if (!isQuietLoginError(error)) {
        notify.error({
          title: t`Could not sign in to FlowPad`,
          message: errorMessage(error, t`The login did not complete.`),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  // A browser sign-in waits for a page with nothing on this screen moving. The small text says
  // where the next step is, and gives a way out of the wait — on the same one line.
  const small = signingIn ? (
    <span className="inline-flex items-center gap-2" data-testid="harness-row-flowpad-waiting">
      <Trans>Finish signing in on the page that opened in your browser.</Trans>
      <button type="button" className="underline" onClick={() => void cloudManager.login()} data-testid="harness-row-flowpad-reopen">
        <Trans>Open the page again</Trans>
      </button>
      <button type="button" className="underline" onClick={() => void cloudManager.cancelLogin()} data-testid="harness-row-flowpad-cancel">
        <Trans>Cancel</Trans>
      </button>
    </span>
  ) : loggedIn ? (
    [email, funds.length ? t`funds ${funds.join(', ')}` : t`funds nothing yet`].filter(Boolean).join(' · ')
  ) : (
    cloudUrl
  );

  return (
    <StatusRow
      testId="harness-row-flowpad"
      emphasis
      mark={<img src={flowpadIcon} alt="" className="h-5 w-5 rounded-sm" />}
      name="FlowPad"
      small={small}
      pill={pill}
      pillFragment="hub-endpoints"
      actionBusy={signingIn}
      action={actionLabel(pill.action)}
      onAction={() => (pill.action === 'details' ? exits.toSources('endpoints') : void connect())}
    />
  );
}

/** One assistant: its pill, its identity, and the one action its state calls for. */
function HarnessRow({
  kind,
  record,
  funding,
  left,
  isDefault,
  onMakeDefault,
}: Facts & { kind: string; isDefault: boolean; onMakeDefault: () => void }) {
  const exits = useExits();
  const h = harnessStatus(record, kind);
  const { worker, Icon, iconClassName } = harnessVisual(h, kind);
  const pill = pillForHarness(record, funding, kind, left);

  const identity = [h?.account.identity, h?.account.plan].filter(Boolean).join(' · ');
  // Signed out while something else pays: a small Sign in button says it AND fixes it.
  const small = pill.note ? (
    <button
      type="button"
      onClick={() => exits.toSignIn(kind)}
      data-testid={`harness-row-${worker}-signin`}
      className="rounded border border-border/70 px-1.5 py-0.5 text-[11px] text-foreground/80 hover:bg-muted"
    >
      <Trans>Sign in</Trans>
    </button>
  ) : (
    identity || undefined
  );

  // The pill names the action; this row only knows where each one goes.
  const onAction = () => {
    if (pill.action === 'sign_in') exits.toSignIn(kind);
    else exits.toSources(pill.action === 'add_key' ? 'keys' : worker);
  };

  return (
    <StatusRow
      testId={`harness-row-${worker}`}
      mark={Icon && <Icon className={`h-5 w-5 ${iconClassName}`} />}
      name={h?.label || worker}
      small={small}
      pill={pill}
      action={actionLabel(pill.action)}
      onAction={onAction}
      isDefault={isDefault}
      onMakeDefault={onMakeDefault}
    />
  );
}

const KEYS_SET = { Icon: KeyRound, short: msg`API key`, label: msg`API keys stored on this machine` };
const KEYS_NONE = { ...KEYS_SET, short: msg`No key` };
const ENDPOINTS_SOME = { Icon: Cloud, short: msg`LLM Endpoint`, label: msg`Hub endpoints your FlowPad account can spend` };
const ENDPOINTS_NONE = { ...ENDPOINTS_SOME, short: msg`No endpoint` };

/** The LLM key store, as one row: how many provider slots have a key. */
function KeysRow({ record }: Pick<Facts, 'record'>) {
  const { t } = useLingui();
  const exits = useExits();
  const s = keysSummary(record);
  const small = s.count
    ? s.stored.map((k) => `${providerLabel(k.provider)}${k.hint ? ` ${k.hint}` : ''}`).join(' · ')
    : s.providers.map(providerLabel).join(' · ');
  return (
    <StatusRow
      testId="row-llm-keys"
      mark={<KeyRound className="h-4 w-4 text-muted-foreground" />}
      name={<Trans>API keys</Trans>}
      small={small}
      pill={s.count ? pillOf('api_key', KEYS_SET, 'details') : pillOf('none', KEYS_NONE, 'details')}
      pillText={t`${s.count} of ${s.total} set`}
      pillFragment="api-keys"
      onAction={() => exits.toSources('keys')}
    />
  );
}

/** The hub endpoints this account can spend, as one row: how many, and what is left. */
function EndpointsRow({ funding, left }: Pick<Facts, 'funding' | 'left'>) {
  const { t } = useLingui();
  const exits = useExits();
  const s = endpointsSummary(funding, left);
  return (
    <StatusRow
      testId="row-llm-endpoints"
      mark={<Cloud className="h-4 w-4 text-muted-foreground" />}
      name={<Trans>Hub endpoints</Trans>}
      small={s.names.join(' · ') || undefined}
      pill={
        s.count
          ? pillOf('hub', ENDPOINTS_SOME, 'details', { usdLeft: s.usdLeft })
          : pillOf('none', ENDPOINTS_NONE, 'details')
      }
      pillText={s.count ? t`${s.count} available` : undefined}
      pillFragment="hub-endpoints"
      onAction={() => exits.toSources('endpoints')}
    />
  );
}

/**
 * The dialog's contents — mounted only while the modal is OPEN.
 *
 * That boundary does two jobs. The root is mounted at app start, so reading funding and the hub
 * chains there would cost every session a hub round-trip for a dialog most never open; here the
 * reads start when it opens. And a fresh mount IS the reset: the
 * "just connected" banner starts clean on every real open, while a redundant `open()` (the LLM
 * setup route calls it from a mount effect) re-renders this component and discards nothing.
 */
function HarnessLoginModalBody({ fresh, dismiss }: { fresh: boolean; dismiss: () => void }) {
  // A row just finished connecting — confirmed IN PLACE rather than by closing, so the person
  // can see it landed before deciding whether they are done here or have more to connect.
  const [justConnected, setJustConnected] = useState<string | null>(null);
  const { status: record } = useStatusRecord();
  const { status: funding } = useLlmSources();
  // Only the endpoints a harness is spending: all the rows here show.
  const left = useHubRemaining(funding, 'in-use');
  // Which assistant is the default is a status fact (`default_harness`); `picked` only holds a
  // choice made here until the backend's push carries it into the record.
  const [picked, setPicked] = useState<string | null>(null);
  const defaultKind = picked ?? (record?.default_harness || null);
  useEffect(() => {
    if (picked && record?.default_harness === picked) setPicked(null);
  }, [picked, record?.default_harness]);

  // Re-check every harness on open (local probes, no money): the dialog that opened because a
  // login failed must not greet the user with the "Signed in" it last recorded. Not when the
  // startup gate opened it straight after its own refresh. Mount only — see the docstring.
  useEffect(() => {
    if (!fresh) refreshHarnessStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Make one assistant the default. Optimistic, and back to the record's default on failure:
   *  the tick is the only feedback, so it must not claim a change that did not land. */
  const makeDefault = useCallback(async (kind: string) => {
    setPicked(kind);
    try {
      await capabilityManager.setReferenceKind(CapabilityKinds.Harness, kind);
    } catch {
      setPicked(null);
    }
  }, []);
  const onConnected = useCallback(() => setJustConnected(i18n._(msg`Signed in to FlowPad.`)), []);

  return (
    <div className="flex flex-col">
      <DialogTitle className="text-lg font-semibold">
        <Trans>Assistants &amp; keys</Trans>
      </DialogTitle>

      <div className="mt-4 flex flex-col gap-1.5">
        {justConnected ? (
          <div
            data-testid="harness-just-connected"
            className="flex items-center justify-between gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm"
          >
            <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <Check className="h-4 w-4" />
              {justConnected}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <Button size="sm" variant="ghost" data-testid="just-connected-keep-open" onClick={() => setJustConnected(null)}>
                <Trans>Keep browsing</Trans>
              </Button>
              <Button size="sm" data-testid="just-connected-close" onClick={dismiss}>
                <Trans>Close</Trans>
              </Button>
            </div>
          </div>
        ) : null}
        <FlowpadRow record={record} funding={funding} onConnected={onConnected} />

        <SectionHeading
          fragment="default-assistant"
          label={i18n._(msg`Default assistant`)}
          hint={
            <span className="flex items-center gap-1 text-muted-foreground/70">
              <Check className="h-3 w-3" />
              <Trans>pick one</Trans>
            </span>
          }
        />
        {HARNESS_CAPABILITY_KINDS.map((kind) => (
          <HarnessRow
            key={kind}
            kind={kind}
            record={record}
            funding={funding}
            left={left}
            isDefault={kind === defaultKind}
            onMakeDefault={() => void makeDefault(kind)}
          />
        ))}

        <SectionHeading fragment="api-keys" label={i18n._(msg`Keys & endpoints`)} />
        <KeysRow record={record} />
        <EndpointsRow funding={funding} left={left} />
      </div>

    </div>
  );
}

/** Mounted once at app start: the startup gate and the dialog shell. Reads nothing while closed. */
export function HarnessLoginModalRoot() {
  const { open, payload, setOpen } = useHarnessLoginStore();
  useHarnessLoginGate();
  // Dismissing is a durable choice — record it so the startup gate stops auto-opening (the
  // footer chip still reopens on demand).
  const dismiss = useCallback(() => {
    markHarnessGateSeen();
    setOpen(false);
  }, [setOpen]);

  if (!open) return null;
  return (
    <Dialog open onOpenChange={(next) => (next ? setOpen(true) : dismiss())}>
      {/* Wide enough that every row fits on ONE line: icon + name + pill + button side by side.
          No open-autofocus: Radix would land it on the first focusable thing, which is the
          FlowPad pill's wiki word, and a ring around "Signed in" on an untouched dialog reads as
          a validation error. */}
      <DialogContent className="sm:max-w-[660px]" onOpenAutoFocus={(e) => e.preventDefault()}>
        <HarnessLoginModalBody fresh={!!payload?.fresh} dismiss={dismiss} />
      </DialogContent>
    </Dialog>
  );
}

export default HarnessLoginModalRoot;
