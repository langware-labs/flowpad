import { Agent, AGENT_PLACE_FIELDS, type AgentPlaceField, type AgentPlaceOverrides } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';

import { AGENT_EFFORTS, AGENT_MODEL_TIERS, AGENT_PERMISSION_MODES, AGENT_WORKER_TYPES } from './agent-vocabularies';

interface AgentPlaceConfigProps {
  agent: Agent;
  deploymentId: string;
  overrides: AgentPlaceOverrides;
  onChanged: () => void | Promise<void>;
}

const SUGGESTIONS: Record<Exclude<AgentPlaceField, 'mcp_servers'>, readonly string[]> = {
  worker_type: AGENT_WORKER_TYPES,
  model: AGENT_MODEL_TIERS,
  permission_mode: AGENT_PERMISSION_MODES,
  effort: AGENT_EFFORTS,
};

function show(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'string') return value || '—';
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '—';
}

/**
 * How this deployment runs: every setting with the value in effect — its own override, else the
 * agent's (the definition). "Change" makes an override for this deployment only; "Reset" drops it.
 * Overrides are written into agent.json under `places`.
 */
export function AgentPlaceConfig({ agent, deploymentId, overrides, onChanged }: AgentPlaceConfigProps) {
  const { t } = useLingui();
  const [editing, setEditing] = useState<{ field: AgentPlaceField; draft: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const labels: Record<AgentPlaceField, string> = {
    worker_type: t`Worker`,
    model: t`Model`,
    permission_mode: t`Permissions`,
    effort: t`Effort`,
    mcp_servers: t`MCP servers`,
  };
  const definition: Record<AgentPlaceField, unknown> = {
    worker_type: agent.worker_type,
    model: agent.model,
    permission_mode: agent.permission_mode,
    effort: agent.effort,
    mcp_servers: undefined,
  };

  const isOwn = (field: AgentPlaceField) => overrides[field] !== undefined && overrides[field] !== null;
  // What the agent itself (the definition) says for a field.
  const agentValue = (field: AgentPlaceField) => (field === 'mcp_servers' ? t`its own servers` : show(definition[field]));

  const write = async (field: AgentPlaceField, value: string | string[] | null) => {
    setBusy(true);
    try {
      await agent.setPlaceOverride(deploymentId, field, value);
      setEditing(null);
      await onChanged();
    } catch (e) {
      notify.error({
        title: t`Could not save the override`,
        message: errorMessage(e, t`Override not saved.`),
        forceToast: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!editing) return;
    const draft = editing.draft.trim();
    if (!draft) return;
    const value =
      editing.field === 'mcp_servers'
        ? draft
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)
        : draft;
    void write(editing.field, value);
  };

  return (
    <div className="flex flex-col gap-2" data-testid="agent-place-config">
      {AGENT_PLACE_FIELDS.map((field) => {
        const own = isOwn(field);
        if (editing?.field === field) return null;
        return (
          <div
            key={field}
            className="flex items-center gap-3 border-b pb-2 last:border-b-0"
            data-testid={own ? `agent-place-override-${field}` : `agent-place-inherited-${field}`}
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {labels[field]}: {own ? show(overrides[field]) : agentValue(field)}
              </div>
              <div className="text-xs text-muted-foreground">
                {own ? t`The agent's: ${agentValue(field)}` : t`From the agent`}
              </div>
            </div>
            {own ? (
              <>
                <span className="shrink-0 rounded-full bg-orange-500/15 px-2 py-0.5 text-[11px] text-orange-700 dark:text-orange-400">
                  <Trans>This deployment</Trans>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void write(field, null)}
                  data-testid={`agent-place-reset-${field}`}
                >
                  <Trans>Reset</Trans>
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !!editing}
                onClick={() => setEditing({ field, draft: '' })}
                data-testid={`agent-place-add-override-${field}`}
              >
                <Trans>Change</Trans>
              </Button>
            )}
          </div>
        );
      })}

      {editing && (
        <div className="flex flex-wrap items-center gap-2" data-testid="agent-place-override-editor">
          <span className="text-sm font-medium">{labels[editing.field]}</span>
          <Input
            id={`place-override-${deploymentId}-${editing.field}`}
            autoFocus
            className="h-8 min-w-[10rem] flex-1 text-sm"
            list={editing.field === 'mcp_servers' ? undefined : `place-override-options-${editing.field}`}
            value={editing.draft}
            placeholder={editing.field === 'mcp_servers' ? t`zendesk, gmail` : show(definition[editing.field])}
            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(null);
            }}
            aria-label={labels[editing.field]}
            data-testid="agent-place-override-input"
          />
          {editing.field !== 'mcp_servers' && (
            <datalist id={`place-override-options-${editing.field}`}>
              {SUGGESTIONS[editing.field].map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          )}
          <Button
            size="sm"
            disabled={busy || !editing.draft.trim()}
            onClick={save}
            data-testid="agent-place-override-save"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trans>Save</Trans>}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}
