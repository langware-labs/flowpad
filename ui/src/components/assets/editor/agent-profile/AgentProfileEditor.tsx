import { Agent, FSRef } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';

import { useEntityByPath } from '@src/hooks/use-entity-by-path';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { renderIconValue } from '@src/lib/icon-value';
import { colorForIdentityKey } from '@src/components/conversation/avatar-color';
import { IconPicker } from '@src/components/ui/icon-picker';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { Switch } from '@src/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';

import { AgentField, AgentListField, AgentSection, AgentSelectField } from './AgentProfileFields';
import {
  AGENT_EFFORTS,
  AGENT_MODEL_TIERS,
  AGENT_PERMISSION_MODES,
  AGENT_WORKER_TYPES,
} from './agent-vocabularies';

interface AgentProfileEditorProps {
  /** FSRef to the agent folder / `agent.md`. */
  fsRef: FSRef;
  /** Pre-resolved agent when the router already has it. */
  agent?: Agent;
}

/**
 * The agent profile editor — an agent is a persona, so it reads like a profile
 * rather than a config file.
 *
 * **Entity-authoritative, and that is load-bearing.** `agent` is
 * `owns_main_ref`: every `save()` makes the backend re-render `agent.md` from
 * these fields (`agent_default_body`), preserving the identity capsule. So the
 * entity is the source of truth and the file is its projection. Two writers are
 * therefore off-limits here:
 *
 *  - `FrontMatterFsRef.save()` rebuilds frontmatter from `name`/`description`
 *    alone — it would drop `avatar` and every option.
 *  - the generic markdown editor's frontmatter buffer parses YAML with a line
 *    regex, so it flattens list values and destroys nested ones (an agent's
 *    `cli_options: {chrome: true}` does not survive it).
 *
 * Going through the entity is what makes those fields safe to edit at all.
 */
export function AgentProfileEditor({ fsRef, agent: providedAgent }: AgentProfileEditorProps) {
  const { t } = useLingui();
  const { entity: discoveredAgent } = useEntityByPath<Agent>(
    providedAgent ? null : Agent.type,
    providedAgent ? null : fsRef,
  );
  const agent = providedAgent ?? discoveredAgent;

  // Keyed on the STABLE typeId so a save() (which hands back a fresh ref)
  // doesn't churn local field state — same reason TaskAssetEditor does it.
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const agentKey = agent ? agent.typeId.toString() : null;

  const [title, setTitle] = useState(agent?.title ?? '');
  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [prompt, setPrompt] = useState(agent?.system_prompt ?? '');

  useEffect(() => {
    setTitle(agent?.title ?? '');
    setName(agent?.name ?? '');
    setDescription(agent?.description ?? '');
    setPrompt(agent?.system_prompt ?? '');
  }, [agentKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(
    async (patch: Partial<Agent>) => {
      const a = agentRef.current;
      if (!a) return;
      Object.assign(a, patch);
      try {
        await a.save();
      } catch (e) {
        notify.error({
          title: t`Could not save agent`,
          message: e instanceof Error ? e.message : t`Save failed.`,
        });
      }
    },
    [t],
  );

  /** Commit a text field only when it actually changed, so blur is cheap. */
  const commit = useCallback(
    <K extends keyof Agent>(key: K, value: Agent[K], current: Agent[K]) => {
      if (value !== current) void save({ [key]: value } as Partial<Agent>);
    },
    [save],
  );

  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </div>
    );
  }

  const identityKey = agent.name || agent.id;
  const ringColor = colorForIdentityKey(identityKey);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        {/* ── header band ─────────────────────────────────────────────── */}
        <div className="flex items-start gap-5">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t`Change avatar`}
                className={cn(
                  'flex h-20 w-20 shrink-0 items-center justify-center rounded-full',
                  'text-3xl text-white shadow-sm transition hover:opacity-90',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  ringColor,
                )}
              >
                {agent.avatar ? (
                  renderIconValue(agent.avatar, { className: 'h-9 w-9 text-3xl' })
                ) : (
                  <Bot className="h-9 w-9" />
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-3" align="start">
              <IconPicker value={agent.avatar} onChange={(v) => void save({ avatar: v ?? undefined })} />
            </PopoverContent>
          </Popover>

          <div className="min-w-0 flex-1 space-y-2">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => commit('title', title.trim(), agent.title ?? '')}
              placeholder={t`Agent title`}
              aria-label={t`Agent title`}
              className="h-auto border-0 bg-transparent px-0 text-2xl font-semibold shadow-none focus-visible:ring-0"
            />
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => commit('name', name.trim(), agent.name ?? '')}
              placeholder={t`agent-name`}
              aria-label={t`Agent name`}
              className="h-7 border-0 bg-transparent px-0 font-mono text-sm text-muted-foreground shadow-none focus-visible:ring-0"
            />
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => commit('description', description.trim(), agent.description ?? '')}
              placeholder={t`What is this agent for?`}
              aria-label={t`Description`}
              className="min-h-0 resize-none border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
              rows={2}
            />
          </div>

          <div className="flex shrink-0 items-center gap-2 pt-2">
            <span className="text-xs text-muted-foreground">
              {agent.enabled ? <Trans>Enabled</Trans> : <Trans>Disabled</Trans>}
            </span>
            <Switch
              checked={agent.enabled}
              onCheckedChange={(v) => void save({ enabled: v })}
              aria-label={t`Enabled`}
            />
          </div>
        </div>

        {/* ── behaviour ───────────────────────────────────────────────── */}
        <AgentSection title={t`Behaviour`} hint={t`Who this agent is. Becomes its system prompt.`}>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => commit('system_prompt', prompt, agent.system_prompt ?? '')}
            placeholder={t`You investigate a reported problem and prove the root cause…`}
            aria-label={t`System prompt`}
            className="min-h-40 font-mono text-sm"
          />
        </AgentSection>

        {/* ── model & runtime ─────────────────────────────────────────── */}
        <AgentSection title={t`Model & runtime`}>
          <div className="grid grid-cols-2 gap-4">
            <AgentSelectField
              label={t`Worker`}
              value={agent.worker_type}
              options={AGENT_WORKER_TYPES}
              placeholder={t`claude`}
              onCommit={(v) => void save({ worker_type: v })}
            />
            <AgentSelectField
              label={t`Model`}
              value={agent.model}
              options={AGENT_MODEL_TIERS}
              placeholder={t`sm / md / lg, or a model id`}
              onCommit={(v) => void save({ model: v })}
            />
            <AgentSelectField
              label={t`Permissions`}
              value={agent.permission_mode}
              options={AGENT_PERMISSION_MODES}
              onCommit={(v) => void save({ permission_mode: v })}
            />
            <AgentSelectField
              label={t`Effort`}
              value={agent.effort}
              options={AGENT_EFFORTS}
              onCommit={(v) => void save({ effort: v })}
            />
            <AgentField
              label={t`Max turns`}
              value={agent.max_turns == null ? '' : String(agent.max_turns)}
              placeholder={t`unlimited`}
              onCommit={(v) => {
                const n = v.trim() === '' ? undefined : Number(v);
                if (n !== undefined && Number.isNaN(n)) return;
                void save({ max_turns: n });
              }}
            />
          </div>
        </AgentSection>

        {/* ── capabilities ────────────────────────────────────────────── */}
        <AgentSection
          title={t`Capabilities`}
          hint={t`Leave a list unset to inherit everything the harness allows. An empty list revokes it.`}
        >
          <div className="space-y-4">
            <AgentListField label={t`Tools`} value={agent.tools} triState onCommit={(v) => void save({ tools: v })} />
            <AgentListField
              label={t`Disallowed tools`}
              value={agent.disallowed_tools}
              triState
              onCommit={(v) => void save({ disallowed_tools: v })}
            />
            <AgentListField
              label={t`Sub-agents`}
              value={agent.subagents}
              onCommit={(v) => void save({ subagents: v ?? [] })}
            />
            <AgentListField label={t`Skills`} value={agent.skills} onCommit={(v) => void save({ skills: v ?? [] })} />
            <AgentListField
              label={t`MCP servers`}
              value={agent.mcp_servers}
              onCommit={(v) => void save({ mcp_servers: v ?? [] })}
            />
          </div>
        </AgentSection>

        {/* ── advanced ────────────────────────────────────────────────── */}
        <AgentSection title={t`Advanced`}>
          <div className="space-y-4">
            <AgentListField
              label={t`Additional directories`}
              value={agent.additional_dirs}
              onCommit={(v) => void save({ additional_dirs: v ?? [] })}
            />
            <div className="flex items-center justify-between">
              <span className="text-sm"><Trans>Load Flowpad assistant</Trans></span>
              <Switch
                checked={agent.load_flowpad_assistant}
                onCheckedChange={(v) => void save({ load_flowpad_assistant: v })}
                aria-label={t`Load Flowpad assistant`}
              />
            </div>
          </div>
        </AgentSection>
      </div>
    </div>
  );
}
