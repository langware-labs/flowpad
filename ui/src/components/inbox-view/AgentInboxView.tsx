import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Agent, type AgentInboxState, TypeId } from '@sdk';
import { Loader2, Mail } from 'lucide-react';
import { useEntity } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { Button } from '@src/components/ui/button';
import { CopyButton } from '@src/components/ui/copy-button';
import { Input } from '@src/components/ui/input';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { useAttentionPolling } from '@src/components/data-sources/useAttentionPolling';
import { notify } from '@src/notifications';
import { InboxView } from './InboxView';

const MIN_REFRESH_SECONDS = 60;

export function AgentInboxView() {
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
  const ensureCloudLogin = useCloudLoginGate();
  const [state, setState] = useState<AgentInboxState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [senders, setSenders] = useState('');
  const [refresh, setRefresh] = useState(String(MIN_REFRESH_SECONDS));
  const activeState = state?.agent_id === parsed.agentId ? state : null;

  const loadState = useCallback(async () => {
    const currentAgent = agentRef.current;
    if (!currentAgent || currentAgent.id !== agentId) return;
    setLoading(true);
    try {
      const next = await currentAgent.inboxState();
      setState(next);
      setSenders((next.inbox?.allowed_senders ?? []).join('\n'));
      setRefresh(String(next.source?.poll_interval_seconds ?? MIN_REFRESH_SECONDS));
    } catch {
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => void loadState(), [loadState]);
  useAttentionPolling(activeState?.source?.id, undefined, parsed.agentId ?? undefined);

  const changeEnabled = useCallback(
    async (enabled: boolean) => {
      if (!agent || saving) return;
      setSaving(true);
      try {
        if (enabled) {
          const gate = await ensureCloudLogin();
          if (!gate.ok) throw new Error(gate.error);
        }
        const next = enabled ? await agent.allocateInbox() : await agent.disableInbox();
        setState(next);
        setSenders((next.inbox?.allowed_senders ?? []).join('\n'));
        setRefresh(String(next.source?.poll_interval_seconds ?? MIN_REFRESH_SECONDS));
      } catch (error) {
        notify.error({
          title: enabled ? t`Could not allocate an inbox` : t`Could not disable the inbox`,
          message: error instanceof Error ? error.message : t`Email settings could not be saved.`,
        });
      } finally {
        setSaving(false);
      }
    },
    [agent, ensureCloudLogin, saving, t],
  );

  const saveConfiguration = useCallback(async () => {
    if (!agent || !activeState?.inbox || saving) return;
    const seconds = Number.parseInt(refresh, 10);
    if (!Number.isInteger(seconds) || seconds < MIN_REFRESH_SECONDS) {
      notify.error({ title: t`Refresh interval must be at least 60 seconds` });
      return;
    }
    const allowed_senders = senders
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    setSaving(true);
    try {
      setState(await agent.configureInbox({ allowed_senders, poll_interval_seconds: seconds }));
      notify.success({ title: t`Inbox settings saved` });
    } catch (error) {
      notify.error({
        title: t`Could not save inbox settings`,
        message: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  }, [activeState?.inbox, agent, refresh, saving, senders, t]);

  if (!parsed.agentId || parsed.view !== 'inbox') return null;
  if (loading || !agent) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-inbox-view">
      <section className="shrink-0 border-b bg-muted/10 px-4 py-3" data-testid="agent-inbox-settings">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Mail className="h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                <Trans>Email inbox</Trans>
              </div>
              {activeState?.inbox ? (
                <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                  <span className="truncate" data-testid="agent-inbox-address">
                    {activeState.inbox.address}
                  </span>
                  <CopyButton
                    value={activeState.inbox.address}
                    title={t`Copy email address`}
                    testId="agent-inbox-copy"
                  />
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  <Trans>No email address allocated</Trans>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {activeState?.enabled ? t`Email enabled` : t`Email disabled`}
            </span>
            <Switch
              checked={activeState?.enabled ?? false}
              disabled={saving}
              onCheckedChange={(checked) => void changeEnabled(checked)}
              aria-label={t`Enable agent email`}
              data-testid="agent-email-enabled"
            />
          </div>
        </div>
        {activeState?.inbox && (
          <div className="mt-3 grid gap-3 md:grid-cols-[minmax(12rem,1fr)_10rem_auto]">
            <label className="text-xs font-medium">
              <Trans>Allowed senders</Trans>
              <Textarea
                className="mt-1 min-h-16 font-mono text-xs"
                value={senders}
                onChange={(event) => setSenders(event.target.value)}
                placeholder={t`one@example.com`}
                data-testid="agent-email-allowed-senders"
              />
            </label>
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
            <Button className="self-end" variant="outline" disabled={saving} onClick={() => void saveConfiguration()}>
              <Trans>Save</Trans>
            </Button>
          </div>
        )}
        {activeState?.source && (
          <div className="mt-2 text-xs text-muted-foreground" data-testid="agent-inbox-health">
            <Trans>Health:</Trans> {activeState.source.health} · <Trans>Last sync:</Trans>{' '}
            {activeState.source.last_synced_at
              ? new Date(activeState.source.last_synced_at).toLocaleString()
              : t`Never`}
          </div>
        )}
      </section>
      {activeState?.inbox ? (
        <div className="min-h-0 flex-1">
          <InboxView agentId={parsed.agentId} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <p>
            <Trans>Enable email to allocate this Agent's inbox.</Trans>
          </p>
          <Button
            type="button"
            disabled={saving}
            onClick={() => void changeEnabled(true)}
            data-testid="agent-email-create"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            <Trans>Create email for agent</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}
