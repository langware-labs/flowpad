import {
  cloudManager,
  setPublicAccess,
  type Agent,
  type AgentVersionState,
  type PublicDeployment,
  type PublicDeploymentMode,
  type PublicDeploymentOp,
  type PublicDeploymentSetup,
  type PublicDeploymentsState,
  type PublicInviteCode,
} from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronLeft, Loader2, Ticket } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { endpointTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { useLlmSources } from '@src/components/llm-sources/use-llm-sources';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { CopyButton } from '@src/components/ui/copy-button';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@src/components/ui/radio-group';
import { WikiTip } from '@src/components/wiki-tip';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { formatTimeAgo } from '@src/utils/format-time-ago';

import { useVisitorRole } from './AgentVisibilitySection';
import { InviteCodesDialog } from './InviteCodesDialog';
import { ItMessageDialog } from './ItMessageDialog';

/** The visitor stamp `visitor-sandbox` is reached through on the hub. */
const VISITOR_RUNNER_ROLE = 'runner';

export const DEFAULT_CAP_USD = 2;
export const DEFAULT_MAX_DEPLOYMENTS = 5;
const POLL_MS = 10_000;

/** `<hub>/open-pc/<agent id>` — the page visitors open; served by the hub's app origin. */
export function openPcLink(agent: Agent): string | null {
  const hubUrl = cloudManager.cloudAppUrl;
  if (!hubUrl) return null;
  return `${hubUrl.replace(/\/+$/, '')}/open-pc/${encodeURIComponent(agent.id)}`;
}

interface Draft {
  mode: PublicDeploymentMode;
  max: number | null;
  source: string;
  capUsd: number | null;
}

function draftOf(state: PublicDeploymentsState | null): Draft {
  const s = state?.settings;
  if (!s) return { mode: 'code', max: DEFAULT_MAX_DEPLOYMENTS, source: '', capUsd: DEFAULT_CAP_USD };
  return { mode: s.mode, max: s.max_deployments, source: s.llm_source ?? '', capUsd: s.cap_usd ?? DEFAULT_CAP_USD };
}

const sameDraft = (a: Draft, b: Draft) =>
  a.mode === b.mode && a.max === b.max && a.source === b.source && a.capUsd === b.capUsd;

/**
 * "Public deployments": visitors open `/open-pc/<id>` — by invite code, or anyone with the link — and land in
 * a sandbox of their own. Enabling also stamps the agent's `visitor` audience public (what lets a visitor
 * reach it at all), the same stamp "Set public" writes; turning off leaves the stamp.
 */
/** The wiki page every IT Enabled tip opens. */
const IT_ENABLED_WIKI = 'IT Enabled';

/**
 * Turn invites on (or update their settings). Visitors reach `visitor-sandbox` only through the `runner` stamp
 * (hub policies.json, agent role `runner`): keep whatever the owner already stamped (e.g. public `reader`) and add
 * `runner`. Answers the visitor stamp as it is now.
 */
export async function turnOnPublicDeployments(
  agent: Agent,
  setup: PublicDeploymentSetup,
  role: string | null,
): Promise<string | null> {
  await agent.enablePublicDeployments(setup);
  const held = (role ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  if (held.includes(VISITOR_RUNNER_ROLE)) return role;
  const access = await setPublicAccess(agent.typeId, 'visitor', [...held, VISITOR_RUNNER_ROLE]);
  return access.roles.join(', ') || null;
}

/**
 * One line per invite: a code, the machine it opened (if any) and who it is for. Link visitors (no code) get a
 * line of their own after the codes. Revoked codes are left out: their machine is gone and they open nothing.
 */
export interface InviteLine {
  code: PublicInviteCode | null;
  box: PublicDeployment | null;
}

export function inviteLines(state: PublicDeploymentsState): InviteLine[] {
  const boxOf = new Map(state.deployments.filter((d) => d.code_id).map((d) => [d.code_id as string, d]));
  const lines: InviteLine[] = state.codes
    .filter((c) => c.state !== 'revoked')
    .map((code) => ({ code, box: boxOf.get(code.id) ?? null }));
  for (const box of state.deployments) if (!box.code_id) lines.push({ code: null, box });
  return lines;
}

export function AgentAutoLaunchTab({
  agent,
  version,
  onBack,
}: {
  agent: Agent;
  version: AgentVersionState | null;
  /** Shown as the invite deployment opened from the Deployments list: a way back to it. */
  onBack?: () => void;
}) {
  const { t } = useLingui();
  const published = version?.published === true;
  const [role, setRole] = useVisitorRole(agent, published);
  const [state, setState] = useState<PublicDeploymentsState | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [busy, setBusy] = useState(false);
  const [codesOpen, setCodesOpen] = useState(false);
  const [revoking, setRevoking] = useState<PublicInviteCode | null>(null);
  // Names as typed, before the hub has them: the poll must not overwrite what is being edited.
  const [names, setNames] = useState<Record<string, string>>({});
  const [resetting, setResetting] = useState<PublicDeployment | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [itOpen, setItOpen] = useState(false);
  // IT Enabled per machine as this screen last set it, over what the hub reported.
  const [itOn, setItOn] = useState<Record<string, boolean>>({});

  const { status } = useLlmSources();
  // Allocating from an endpoint takes administering it — the hub checks the same right.
  const sources = useMemo(
    () => (status?.available ?? []).filter((e) => e.kind === 'hub' && e.can_administer === true),
    [status],
  );

  const agentRef = useRef(agent);
  agentRef.current = agent;
  const savedKey = useRef<string | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await agentRef.current.publicDeployments();
      // A fresh read resets the draft only when the saved settings changed, so a poll keeps an edit.
      const key = JSON.stringify(next.settings);
      if (key !== savedKey.current) {
        savedKey.current = key;
        setDraft(draftOf(next));
      }
      setState(next);
    } catch {
      setState((prev) => prev ?? { settings: null, codes: [], deployments: [] });
    }
  }, []);

  useEffect(() => {
    if (published) void load();
  }, [published, load, agent.id]);

  // Poll only while boxes can exist (on, or some left over): each read costs a provider call per box.
  const watching =
    published && (Boolean(state?.settings?.allow_visitor_deployment) || (state?.deployments.length ?? 0) > 0);
  useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [watching, load]);

  if (!version) return null;
  if (!published) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="agent-autolaunch-unpublished">
        <Trans>Publish the agent first to let visitors open it.</Trans>
      </p>
    );
  }
  if (!state) return <Loader2 className="h-4 w-4 animate-spin" data-testid="agent-autolaunch-loading" />;

  const enabled = state.settings?.allow_visitor_deployment === true;
  const saved = draftOf(state);
  // Every public box is funded: a visitor came for the agent, never to set up a token source. The
  // first enable takes the owner's first endpoint; they can pick another below.
  const source = draft.source || (sources[0] ? endpointTypeId(sources[0].id) : '');
  const ready = Boolean(source) && draft.capUsd !== null && draft.capUsd > 0;
  const link = openPcLink(agent);
  const lines = inviteLines(state);
  const agentLabel = agent.displayName || agent.name;
  const activeCodes = lines.filter((l) => l.code).length;
  const nameOf = (code: PublicInviteCode) => names[code.id] ?? code.name ?? '';
  const saveName = async (code: PublicInviteCode) => {
    const next = (names[code.id] ?? code.name ?? '').trim();
    if (next === (code.name ?? '')) return;
    try {
      await agent.renamePublicCode(code.id, next);
      await load();
    } catch (e) {
      notify.error({ title: t`Could not rename the invite`, message: errorMessage(e, t`The hub refused the change.`) });
    } finally {
      setNames((prev) => {
        const rest = { ...prev };
        delete rest[code.id];
        return rest;
      });
    }
  };
  const revoke = async (code: PublicInviteCode) => {
    try {
      await agent.revokePublicCode(code.id);
      await load();
    } catch (e) {
      notify.error({ title: t`Could not revoke the code`, message: errorMessage(e, t`The hub refused the change.`) });
    }
  };
  // Who a reset or a revoke is about: the invite's name when it has one, else its code.
  const whoOf = (code: PublicInviteCode | null | undefined) =>
    code?.name ? code.name : code ? `••••${code.last4}` : t`this visitor`;
  const resettingWho = whoOf(state.codes.find((c) => c.id === resetting?.code_id));
  const resettingCode = resetting?.code_last4 ? `••••${resetting.code_last4}` : '';
  const revokingWho = whoOf(revoking);

  const enable = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const setup: PublicDeploymentSetup = {
        mode: draft.mode,
        max_deployments: draft.max,
        ...(state.settings ? { wrong_code_limit_per_hour: state.settings.wrong_code_limit_per_hour } : {}),
        llm_source: source,
        cap_usd: draft.capUsd as number,
      };
      const stamped = await turnOnPublicDeployments(agent, setup, role);
      if (stamped !== role) setRole(stamped);
      await load();
    } catch (e) {
      notify.error({
        title: t`Could not turn on public deployments`,
        message: errorMessage(e, t`The hub refused the change.`),
        forceToast: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await agent.disablePublicDeployments();
      await load();
    } catch (e) {
      notify.error({
        title: t`Could not turn off public deployments`,
        message: errorMessage(e, t`The hub refused the change.`),
        forceToast: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const manage = async (row: PublicDeployment, op: PublicDeploymentOp) => {
    // Opened in the click, filled after the call: a window opened after an await is eaten by popup blockers.
    const tab = op === 'open' ? window.open('about:blank', '_blank') : null;
    setRowBusy(row.node_typeid);
    try {
      const result = await agent.managePublicDeployment(row.node_typeid, op);
      if (op === 'open' && result.workspace_url) {
        if (tab) tab.location.href = result.workspace_url;
        else window.open(result.workspace_url, '_blank');
      }
      await load();
    } catch (e) {
      tab?.close();
      notify.error({
        title: t`Could not change the sandbox`,
        message: errorMessage(e, t`The hub refused the change.`),
      });
    } finally {
      setRowBusy(null);
    }
  };

  const itStateOf = (d: PublicDeployment): boolean | null => itOn[d.node_typeid] ?? d.it_enabled ?? null;
  // The tooltip of a machine's IT Enabled chip: what it is, and what a click does.
  const itTip = (on: boolean | null) =>
    on === null
      ? t`IT Enabled not known yet for this machine. Click to enable it.`
      : on
        ? t`IT Enabled: you can send this machine IT messages. Never while someone is signed in. Click to disable.`
        : t`IT Disabled: this machine refuses IT messages. Click to enable.`;

  const toggleIt = async (row: PublicDeployment) => {
    const next = !(itStateOf(row) ?? false);
    setRowBusy(row.node_typeid);
    try {
      const boxes = await agent.setItSessions([row.node_typeid], next);
      const box = boxes.find((b) => b.node_typeid === row.node_typeid);
      if (box?.error) throw new Error(box.error);
      setItOn((prev) => ({ ...prev, [row.node_typeid]: box ? box.on : next }));
    } catch (e) {
      notify.error({
        title: t`Could not change IT Enabled`,
        message: errorMessage(e, t`The machine did not answer.`),
      });
    } finally {
      setRowBusy(null);
    }
  };

  const statusLabel = (s: string) => {
    switch (s.toUpperCase()) {
      case 'READY':
        return t`Running`;
      case 'PAUSED':
        return t`Paused`;
      case 'STARTING':
        return t`Starting`;
      case 'STOPPED':
        return t`Stopped`;
      default:
        return s;
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="agent-autolaunch">
      {onBack && (
        <>
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
            data-testid="agent-invite-back"
          >
            <ChevronLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
            <Trans>Deployments</Trans>
          </button>
          <div className="flex items-center gap-2">
            <Ticket className="h-5 w-5 text-primary" />
            <h2 className="text-sm font-semibold">
              <Trans>Invite · {agentLabel}</Trans>
            </h2>
            <span className="text-xs text-muted-foreground">{enabled ? t`On` : t`Off`}</span>
          </div>
        </>
      )}
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={enabled}
          disabled={busy || (!enabled && !ready)}
          onCheckedChange={(v) => void (v === true ? enable() : disable())}
          data-testid="agent-autolaunch-allow"
        />
        <Trans>Allow public deployments</Trans>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </label>
      <p className="-mt-3 ms-6 text-xs text-muted-foreground" data-testid="agent-autolaunch-consent">
        <Trans>Each visitor gets a copy of this agent&apos;s project in their own sandbox.</Trans>
      </p>
      {!enabled && sources.length === 0 && (
        <p className="-mt-2 ms-6 text-xs text-destructive" data-testid="agent-autolaunch-no-source">
          <Trans>Add an LLM endpoint you administer first (LLM Endpoints): visitors are funded from it.</Trans>
        </p>
      )}

      {enabled && (
        <>
          {link && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">
                <Trans>Open PC link</Trans>
              </p>
              <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="agent-autolaunch-link">
                  {link}
                </span>
                <CopyButton
                  value={link}
                  title={t`Copy link`}
                  testId="agent-autolaunch-link-copy"
                  className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                />
              </div>
            </div>
          )}

          <div>
            <p className="mb-1 text-xs font-medium">
              <Trans>Who can open it</Trans>
            </p>
            <RadioGroup
              value={draft.mode}
              onValueChange={(v) => setDraft({ ...draft, mode: v as PublicDeploymentMode })}
              className="gap-1.5"
            >
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="link" data-testid="agent-autolaunch-mode-link" />
                <Trans>Anyone with the link</Trans>
              </label>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="code" data-testid="agent-autolaunch-mode-code" />
                  <Trans>Invite code only</Trans>
                </label>
              </div>
            </RadioGroup>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Label htmlFor="agent-autolaunch-max" className="text-xs">
              <Trans>At most</Trans>
            </Label>
            <Input
              id="agent-autolaunch-max"
              type="number"
              min={1}
              className="h-8 w-20 text-xs"
              value={draft.max ?? ''}
              placeholder={t`no limit`}
              onChange={(e) => setDraft({ ...draft, max: e.target.value === '' ? null : Number(e.target.value) })}
              data-testid="agent-autolaunch-max"
            />
            <span>
              <Trans>deployments at once</Trans>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
              value={draft.source}
              onChange={(e) => setDraft({ ...draft, source: e.target.value })}
              aria-label={t`LLM source users spend`}
              data-testid="agent-autolaunch-source"
            >
              {!draft.source && <option value="">{t`Choose the LLM endpoint users spend`}</option>}
              {sources.map((e) => (
                <option key={e.id} value={endpointTypeId(e.id)}>
                  {e.name}
                </option>
              ))}
              {/* The saved source, even when this account cannot administer it any more. */}
              {draft.source && !sources.some((e) => endpointTypeId(e.id) === draft.source) && (
                <option value={draft.source}>{draft.source}</option>
              )}
            </select>
            <Label htmlFor="agent-autolaunch-cap" className="text-xs">
              <Trans>$ per user</Trans>
            </Label>
            <Input
              id="agent-autolaunch-cap"
              type="number"
              min={0}
              step="0.5"
              className="h-8 w-24 text-xs"
              value={draft.capUsd ?? ''}
              onChange={(e) => setDraft({ ...draft, capUsd: e.target.value === '' ? null : Number(e.target.value) })}
              data-testid="agent-autolaunch-cap"
            />
          </div>

          {!sameDraft(draft, saved) && (
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void enable()}
                disabled={busy || !ready}
                data-testid="agent-autolaunch-update"
              >
                <Trans>Update</Trans>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDraft(saved)} disabled={busy}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          )}
        </>
      )}

      {(enabled || lines.length > 0) && (
        <div>
          <div className="mb-1 flex items-center gap-2">
            <p className="flex-1 text-xs font-medium" data-testid="agent-invite-count">
              <Trans>
                Invites · {activeCodes} codes · {state.deployments.length} machines
              </Trans>
            </p>
            {draft.mode === 'code' && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setCodesOpen(true)}
                data-testid="agent-autolaunch-codes"
              >
                <Trans>Add codes</Trans>
              </Button>
            )}
            <WikiTip
              wikiword={IT_ENABLED_WIKI}
              label={t`Ask every IT Enabled machine one thing; the answers come back as one IT conversation in your StreamInbox.`}
              learnMore
            >
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={state.deployments.length === 0}
                onClick={() => setItOpen(true)}
                data-testid="it-message-send-open"
              >
                <Trans>Send IT message</Trans>
              </Button>
            </WikiTip>
          </div>
          {lines.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="agent-autolaunch-no-deployments">
              <Trans>No invites yet.</Trans>
            </p>
          ) : (
            <ul className="divide-y rounded-md border border-border" data-testid="agent-invite-lines">
              {lines.map(({ code, box: d }) => {
                const paused = d?.status.toUpperCase() === 'PAUSED';
                const rowLocked = !!d && rowBusy === d.node_typeid;
                return (
                  <li
                    key={code?.id ?? d?.node_typeid}
                    className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs"
                    data-testid={d ? 'agent-autolaunch-deployment' : 'agent-invite-unused'}
                  >
                    {code ? (
                      <Input
                        className="h-7 w-40 text-xs"
                        value={nameOf(code)}
                        placeholder={t`Add a name (optional)`}
                        aria-label={t`Name of invite ••••${code.last4}`}
                        onChange={(e) => setNames((prev) => ({ ...prev, [code.id]: e.target.value }))}
                        onBlur={() => void saveName(code)}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        data-testid="agent-invite-name"
                      />
                    ) : (
                      <span className="w-40 text-muted-foreground">{t`link visitor`}</span>
                    )}
                    <span className="w-20 font-mono">{code ? `••••${code.last4}` : ''}</span>
                    {d ? (
                      <>
                        <span className="w-16">{statusLabel(d.status)}</span>
                        <WikiTip wikiword={IT_ENABLED_WIKI} label={itTip(itStateOf(d))} learnMore openDelay={400}>
                          <button
                            type="button"
                            className={`w-24 text-start ${
                              itStateOf(d) ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                            }`}
                            disabled={rowLocked}
                            onClick={() => void toggleIt(d)}
                            aria-label={itTip(itStateOf(d))}
                            data-it-enabled={itStateOf(d) === null ? 'unknown' : String(itStateOf(d))}
                            data-testid="it-sessions-state"
                          >
                            {itStateOf(d) === null ? t`IT —` : itStateOf(d) ? t`IT Enabled` : t`IT Disabled`}
                          </button>
                        </WikiTip>
                        <span className="flex-1 text-muted-foreground">{formatTimeAgo(d.last_used_at) ?? '—'}</span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          disabled={rowLocked}
                          onClick={() => void manage(d, 'open')}
                        >
                          <Trans>Open</Trans>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          disabled={rowLocked}
                          onClick={() => void manage(d, paused ? 'resume' : 'pause')}
                        >
                          {paused ? <Trans>Resume</Trans> : <Trans>Pause</Trans>}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          disabled={rowLocked}
                          onClick={() => setResetting(d)}
                          data-testid="agent-invite-reset"
                        >
                          <Trans>Reset</Trans>
                        </Button>
                        {code && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            disabled={rowLocked}
                            onClick={() => setRevoking(code)}
                            data-testid="agent-invite-revoke"
                          >
                            <Trans>Revoke</Trans>
                          </Button>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="w-16 text-muted-foreground">{t`Unused`}</span>
                        <span className="flex-1 text-muted-foreground">{t`not opened yet`}</span>
                        {code && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => setRevoking(code)}
                            data-testid="agent-invite-revoke"
                          >
                            <Trans>Revoke</Trans>
                          </Button>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Mounted only while open: the conversation dialog navigates, and this tab also renders outside a router. */}
      {itOpen && (
        <ItMessageDialog
          agent={agent}
          open
          onClose={() => setItOpen(false)}
          machines={state.deployments.length}
          off={state.deployments.filter((d) => itStateOf(d) === false).length}
        />
      )}
      <InviteCodesDialog agent={agent} open={codesOpen} onOpenChange={setCodesOpen} onChanged={load} />
      <ConfirmDialog
        open={resetting !== null}
        onOpenChange={(o) => !o && setResetting(null)}
        title={t`Reset ${resettingWho}'s machine?`}
        description={t`Wipes the machine and starts it fresh from the agent's project. Anything not shared is lost. The code ${resettingCode} stays ${resettingWho}'s.`}
        confirmLabel={t`Reset`}
        cancelLabel={t`Cancel`}
        variant="destructive"
        onConfirm={() => resetting && void manage(resetting, 'reset')}
        testId="agent-autolaunch-reset"
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={t`Revoke ${revokingWho}'s invite?`}
        description={
          revoking?.state === 'in_use'
            ? t`The code stops working and its machine is deleted.`
            : t`The code stops working.`
        }
        confirmLabel={t`Revoke`}
        cancelLabel={t`Cancel`}
        variant="destructive"
        onConfirm={() => revoking && void revoke(revoking)}
        testId="invite-code-revoke"
      />
    </div>
  );
}
