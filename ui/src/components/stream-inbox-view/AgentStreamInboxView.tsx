import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Agent, type AgentMailboxState, TypeId } from '@sdk';
import { Loader2, Mail } from 'lucide-react';
import { useEntity } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { Button } from '@src/components/ui/button';
import { CopyButton } from '@src/components/ui/copy-button';
import { Input } from '@src/components/ui/input';
import { MailboxListsEditor } from '@src/components/agents/MailboxListsEditor';
import { useAllocateAgentMailbox } from '@src/hooks/use-allocate-agent-mailbox';
import { useAttentionPolling } from '@src/components/data-sources/useAttentionPolling';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { AttachedChannelsBar, useAttachedChannels } from './AttachedChannelsBar';
import { channelKeyOf } from './channel-owner';
import { StreamInboxView } from './StreamInboxView';

const MIN_REFRESH_SECONDS = 60;
/** Nothing to narrow while the agent has no channel. */
const NO_FILTER: ReadonlySet<string> = new Set();

export function AgentStreamInboxView() {
  const { t } = useLingui();
  const { currentDock } = useDockNavigation();
  const parsed = useMemo(
    () =>
      currentDock?.viewType === ViewType.AGENT
        ? DockPointer.parseAgentPointer(currentDock.pointer)
        : { agentId: null, view: null },
    [currentDock?.viewType, currentDock?.pointer],
  );
  const agentTypeId = useMemo(() => (parsed.agentId ? new TypeId(Agent.type, parsed.agentId) : null), [parsed.agentId]);
  const { data: agent } = useEntity<Agent>(agentTypeId);
  const agentId = agent?.id ?? null;
  const agentRef = useRef<Agent | null>(null);
  agentRef.current = agent ?? null;
  const allocateMailbox = useAllocateAgentMailbox();
  const [state, setState] = useState<AgentMailboxState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(String(MIN_REFRESH_SECONDS));
  const activeState = state?.agent_id === parsed.agentId ? state : null;
  // The agent's channels — the stream inbox header's own rows, so "has a
  // channel at all" and what that header shows can never disagree.
  const { rows: channels, specFor, offers, builtInOffered } = useAttachedChannels(agentTypeId);
  // The channel the list opens on: the URL's (`?channel=`, a mark pressed on the agent page), else the
  // agent's email — what a person coming here is after. A standard stream inbox, filtered, not a special list.
  const urlChannel = currentDock?.options?.channel;
  // The mailbox state names its source by id only (no provider/channel), so the key comes from that
  // source's full row among the agent's channels.
  const mailboxSource = activeState?.source ? channels.find((s) => s.id === activeState.source?.id) : undefined;
  const initialChannel = urlChannel || (mailboxSource ? channelKeyOf(mailboxSource) : undefined);

  const loadState = useCallback(async () => {
    const currentAgent = agentRef.current;
    if (!currentAgent || currentAgent.id !== agentId) return;
    setLoading(true);
    try {
      const next = await currentAgent.mailboxState();
      setState(next);
      setRefresh(String(next.source?.poll_interval_seconds ?? MIN_REFRESH_SECONDS));
    } catch {
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => void loadState(), [loadState]);
  useAttentionPolling(activeState?.source?.id, undefined, parsed.agentId ?? undefined);

  // Allocating is the hub-side act — an address nobody had. Listening on/off
  // is NOT here any more: that is the channels bar's toggle, the same verb for
  // the mailbox as for every other channel.
  const createEmail = useCallback(async () => {
    if (!agent || saving) return;
    setSaving(true);
    try {
      const next = await allocateMailbox(agent);
      if (!next) return;
      setState(next);
      setRefresh(String(next.source?.poll_interval_seconds ?? MIN_REFRESH_SECONDS));
    } finally {
      setSaving(false);
    }
  }, [agent, allocateMailbox, saving]);

  const saveConfiguration = useCallback(async () => {
    if (!agent || !activeState?.mailbox || saving) return;
    const seconds = Number.parseInt(refresh, 10);
    if (!Number.isInteger(seconds) || seconds < MIN_REFRESH_SECONDS) {
      notify.error({ title: t`Refresh interval must be at least 60 seconds`, forceToast: true });
      return;
    }
    setSaving(true);
    try {
      setState(await agent.configureMailbox({ poll_interval_seconds: seconds }));
      notify.success({ title: t`Mailbox settings saved` });
    } catch (error) {
      notify.error({
        title: t`Could not save mailbox settings`,
        message: errorMessage(error, t`Mailbox settings could not be saved.`),
        forceToast: true,
      });
    } finally {
      setSaving(false);
    }
  }, [activeState?.mailbox, agent, refresh, saving, t]);

  if (!parsed.agentId || parsed.view !== 'stream_inbox') return null;
  if (loading || !agent) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-stream-inbox-view">
      <section className="shrink-0 border-b bg-muted/10 px-4 py-3" data-testid="agent-mailbox-settings">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Mail className="h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                <Trans>Agent mailbox</Trans>
              </div>
              {activeState?.mailbox ? (
                <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                  <span className="truncate" data-testid="agent-mailbox-address">
                    {activeState.mailbox.address}
                  </span>
                  <CopyButton
                    value={activeState.mailbox.address}
                    title={t`Copy email address`}
                    testId="agent-mailbox-copy"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  disabled={saving}
                  onClick={() => void createEmail()}
                  data-testid="agent-email-create"
                >
                  <Trans>No built-in email yet — create it</Trans>
                </button>
              )}
            </div>
          </div>
        </div>
        {activeState?.mailbox && (
          <div className="mt-3 flex flex-col gap-3">
            <MailboxListsEditor agent={agent} mailbox={activeState.mailbox} onSaved={setState} />
            <div className="flex items-end gap-3">
              <label className="text-xs font-medium">
                <Trans>Refresh every (seconds)</Trans>
                <Input
                  className="mt-1"
                  type="number"
                  min={MIN_REFRESH_SECONDS}
                  value={refresh}
                  onChange={(event) => setRefresh(event.target.value)}
                  data-testid="agent-email-refresh-seconds"
                />
              </label>
              <Button variant="outline" disabled={saving} onClick={() => void saveConfiguration()}>
                <Trans>Save</Trans>
              </Button>
            </div>
          </div>
        )}
        {activeState?.source && (
          <div className="mt-2 text-xs text-muted-foreground" data-testid="agent-mailbox-health">
            <Trans>Health:</Trans> {activeState.source.health} · <Trans>Last sync:</Trans>{' '}
            {activeState.source.last_synced_at
              ? new Date(activeState.source.last_synced_at).toLocaleString()
              : t`Never`}
          </div>
        )}
      </section>
      {activeState?.mailbox || channels.length > 0 ? (
        <div className="min-h-0 flex-1">
          {/* Keyed on the opening channel: the mailbox source lands after the first render, and the
              list must open on it, not remember the empty filter it was first built with. */}
          <StreamInboxView
            key={initialChannel ?? ''}
            agentId={parsed.agentId}
            initialChannel={initialChannel}
            emptyHint={
              activeState?.mailbox &&
              !activeState.mailbox.open_senders &&
              (activeState.mailbox.allowed_senders ?? []).length === 0 ? (
                <span data-testid="agent-stream-inbox-no-senders">
                  <Trans>Nobody may write to this agent yet — add their address under Allowed senders.</Trans>
                </span>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          {/* The header line's + is how an agent gets a non-email channel, so the
              empty state keeps it rather than leaving email as the only way in. */}
          {agentTypeId && (
            <AttachedChannelsBar
              owner={agentTypeId}
              rows={channels}
              specFor={specFor}
              offers={offers}
              builtInOffered={builtInOffered}
              selected={NO_FILTER}
              onSelectedChange={() => undefined}
            />
          )}
          <p>
            <Trans>No channel reaches this agent yet. Give it its built-in email to start.</Trans>
          </p>
          <Button
            type="button"
            disabled={saving}
            onClick={() => void createEmail()}
            data-testid="agent-email-create-cta"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            <Trans>Create built-in email</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}
