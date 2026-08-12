import { Agent, AGENT_AVATAR_REF, FSRef } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';

import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { AvatarValue } from '@src/lib/avatar-value';
import { colorForIdentityKey } from '@src/components/conversation/avatar-color';
import { AgentAvatarPicker } from '@src/components/ui/agent-avatar-picker';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { prepareAvatarImage } from '@src/lib/prepare-avatar-image';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { Switch } from '@src/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Button } from '@src/components/ui/button';

import { AgentDeploymentsSection } from './AgentDeploymentsSection';
import { AgentListField, AgentSection, AgentSelectField } from './AgentProfileFields';
import { AgentRunDialog } from './AgentRunDialog';
import { AGENT_EFFORTS, AGENT_MODEL_TIERS, AGENT_PERMISSION_MODES, AGENT_WORKER_TYPES } from './agent-vocabularies';
import { AgentDocumentPatch, patchAgentDocument } from './agent-document';

interface AgentProfileEditorProps {
  /** Always resolved — AssetEditorRouter renders this inside an
   *  EntityResolutionGate, which only calls render() with a non-null entity. */
  agent: Agent;
  /** Primary agent.md ref returned by the entity's record/refs action. */
  mainRef: FSRef;
  /** Refresh the entity projection after a durable VFS write. */
  onSaved?: () => void | Promise<unknown>;
}

/**
 * The agent profile editor — an agent is a persona, so it reads like a profile
 * rather than a config file.
 *
 * The entity record resolves the filesystem authority. On desktop that ref is
 * backed by the local checkout; in cloud it is backed by the Agent's Git
 * origin. The editor always patches agent.md through the same ordinary VFS
 * contract, preserving unknown YAML and identity data.
 */
export function AgentProfileEditor({ agent, mainRef, onSaved }: AgentProfileEditorProps) {
  const { t } = useLingui();

  // Keyed on the STABLE typeId so a save() (which hands back a fresh ref)
  // doesn't churn local field state — same reason TaskAssetEditor does it.
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const writeQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const agentKey = agent ? agent.typeId.toString() : null;

  const [title, setTitle] = useState(agent?.title ?? '');
  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [prompt, setPrompt] = useState(agent?.system_prompt ?? '');
  const [runOpen, setRunOpen] = useState(false);
  const [avatarRevision, setAvatarRevision] = useState(0);

  useEffect(() => {
    setTitle(agent?.title ?? '');
    setName(agent?.name ?? '');
    setDescription(agent?.description ?? '');
    setPrompt(agent?.system_prompt ?? '');
  }, [agentKey, agent.description, agent.name, agent.system_prompt, agent.title]);

  const save = useCallback(
    (patch: AgentDocumentPatch): Promise<boolean> => {
      const operation = writeQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const source = await mainRef.read();
          const nextSource = patchAgentDocument(source, patch);
          if (nextSource !== source) await mainRef.write(nextSource);
          Object.assign(agentRef.current, patch);
          await onSaved?.();
          return true;
        })
        .catch((e) => {
          notify.error({
            title: t`Could not save agent`,
            message: e instanceof Error ? e.message : t`Save failed.`,
          });
          return false;
        });
      writeQueueRef.current = operation;
      return operation;
    },
    [mainRef, onSaved, t],
  );

  const handleAvatarImage = useCallback(
    async (file: File) => {
      if (!agentRef.current) {
        notify.error({ title: t`Could not upload avatar`, message: t`The Agent bundle is not available.` });
        return;
      }
      try {
        const prepared = await prepareAvatarImage(file);
        const upload = await mainRef.parent.uploadFile(prepared);
        await upload.waitForCompletion();
        if (await save({ avatar: AGENT_AVATAR_REF })) setAvatarRevision((value) => value + 1);
      } catch (error) {
        notify.error({
          title: t`Could not upload avatar`,
          message: error instanceof Error ? error.message : t`Upload failed.`,
        });
      }
    },
    [mainRef, save, t],
  );

  /** Commit a text field only when it actually changed, so blur is cheap. */
  const commit = useCallback(
    <K extends keyof AgentDocumentPatch>(key: K, value: AgentDocumentPatch[K], current: AgentDocumentPatch[K]) => {
      if (value !== current) void save({ [key]: value } as AgentDocumentPatch);
    },
    [save],
  );

  const identityKey = agent.name || agent.id;
  const ringColor = colorForIdentityKey(identityKey);
  const AgentIcon = iconForType(Agent.type);
  const avatarImageUrl = agent.avatar === AGENT_AVATAR_REF ? mainRef.parent.child('avatar.png').getDownloadUrl() : null;

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
                  'flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full',
                  'text-3xl text-white shadow-sm transition hover:opacity-90',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  ringColor,
                )}
              >
                <AvatarValue
                  key={`${agent.avatar ?? 'none'}:${avatarRevision}`}
                  value={agent.avatar}
                  imageUrl={avatarImageUrl}
                  alt={agent.name ? t`${agent.name} avatar` : t`Agent avatar`}
                  className={avatarImageUrl ? 'h-full w-full object-cover' : 'h-9 w-9 text-3xl'}
                  fallback={<AgentIcon className="h-9 w-9" />}
                />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-3" align="start">
              <AgentAvatarPicker
                value={agent.avatar}
                onValueChange={(value) => save({ avatar: value })}
                onImageSelected={handleAvatarImage}
              />
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

          <div className="flex shrink-0 items-center gap-3 pt-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {agent.enabled ? <Trans>Enabled</Trans> : <Trans>Disabled</Trans>}
              </span>
              <Switch
                checked={agent.enabled}
                onCheckedChange={(v) => void save({ enabled: v })}
                aria-label={t`Enabled`}
              />
            </div>
            <Button size="sm" disabled={!agent.enabled} onClick={() => setRunOpen(true)}>
              <Play className="me-1.5 h-3.5 w-3.5" />
              <Trans>Run</Trans>
            </Button>
          </div>
        </div>

        <AgentRunDialog agent={agent} open={runOpen} onOpenChange={setRunOpen} />

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
            <AgentSelectField
              label={t`Max turns`}
              value={agent.max_turns == null ? '' : String(agent.max_turns)}
              placeholder={t`unlimited`}
              onCommit={(v) => {
                const n = v == null ? undefined : Number(v);
                if (n !== undefined && Number.isNaN(n)) return;
                void save({ max_turns: n });
              }}
            />
          </div>
        </AgentSection>

        {/* ── capabilities ────────────────────────────────────────────── */}
        <AgentSection title={t`Capabilities`} hint={t`Declared on the agent's card. Not yet applied to the worker.`}>
          <div className="space-y-4">
            <AgentListField label={t`Tools`} value={agent.tools} onCommit={(v) => void save({ tools: v })} />
            <AgentListField
              label={t`Disallowed tools`}
              value={agent.disallowed_tools}
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

        {/* ── deployment ──────────────────────────────────────────────── */}
        <AgentDeploymentsSection agent={agent} />

        {/* ── advanced ────────────────────────────────────────────────── */}
        <AgentSection title={t`Advanced`}>
          <div className="space-y-4">
            <AgentListField
              label={t`Additional directories`}
              value={agent.additional_dirs}
              onCommit={(v) => void save({ additional_dirs: v ?? [] })}
            />
            <div className="flex items-center justify-between">
              <span className="text-sm">
                <Trans>Load Flowpad assistant</Trans>
              </span>
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
