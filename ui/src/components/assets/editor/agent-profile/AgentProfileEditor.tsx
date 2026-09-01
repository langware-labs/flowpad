import { Agent, AGENT_AVATAR_FILE, AGENT_AVATAR_REF, FSRef } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';

import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { colorForIdentityKey } from '@src/components/conversation/avatar-color';
import { AgentAvatar } from '@src/components/agents/AgentAvatar';
import { AgentAvatarPicker } from '@src/components/ui/agent-avatar-picker';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { prepareAvatarImage } from '@src/lib/prepare-avatar-image';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { Switch } from '@src/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Button } from '@src/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';

import { AgentDeploymentsSection } from './AgentDeploymentsSection';
import { AgentListField, AgentSelectField } from './AgentProfileFields';
import { useProject } from '@sdk/react/hooks';
import { useAgentLauncher } from '@src/components/agents/use-agent-launcher';
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
  const [avatarRevision, setAvatarRevision] = useState(0);
  // The ACTIVE project is the one a session opened from here acts in — an
  // agent supplied by an attached help desk lives in the desk's checkout, and
  // launching into THAT would open the session in the vendor's repo.
  const { project: activeProject } = useProject();
  const { launch, busyId } = useAgentLauncher();
  // Covers the pre-launch write flush too, so the button stays busy for the
  // WHOLE operation — `busyId` alone leaves it clickable during the flush,
  // and every click mints a fresh session.
  const [flushing, setFlushing] = useState(false);
  const using = flushing || busyId === agent?.id;

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
          const changed = nextSource !== source;
          if (changed) {
            await mainRef.write(nextSource);
            agentRef.current.markEdit();
          }
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
        agentRef.current.markEdit();
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

  /** Launch only once the pending field write has landed.
   *
   * Clicking Use blurs the focused field first, so `commit` has already
   * queued the system-prompt save — but it queues it fire-and-forget, and
   * `use` reads the agent ROW on the backend. Without this await the launch
   * races the write and can open the session on the pre-edit persona.
   * `writeQueueRef` is the same tail `save` chains onto, so awaiting it
   * drains every queued field, not just the prompt. */
  const handleUse = useCallback(async () => {
    setFlushing(true);
    try {
      await writeQueueRef.current;
      await launch(agent, activeProject?.id ?? null);
    } finally {
      setFlushing(false);
    }
  }, [agent, activeProject?.id, launch]);

  const identityKey = agent.name || agent.id;
  const ringColor = colorForIdentityKey(identityKey);
  const AgentIcon = iconForType(Agent.type);
  // Through `mainRef`, not `agent.avatarImageUrl`: the router hands the editor
  // the authoritative ref (local mount OR hub entity storage), while the SDK
  // getter resolves off `asset_ref` — same file here, but this one is exact.
  const avatarImageUrl =
    agent.avatar === AGENT_AVATAR_REF ? mainRef.parent.child(AGENT_AVATAR_FILE).getDownloadUrl() : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── header band: identity + the two verbs ─────────────────────── */}
      <div className="flex shrink-0 items-start gap-5 border-b border-border px-6 pb-5 pt-6">
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
              <AgentAvatar
                key={`${agent.avatar ?? 'none'}:${avatarRevision}`}
                agent={agent}
                imageUrl={avatarImageUrl}
                className="h-full w-full bg-transparent text-3xl"
                glyphClassName="h-9 w-9 text-3xl"
                fallback={<AgentIcon className="h-9 w-9" />}
              />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3" align="start">
            <AgentAvatarPicker
              value={agent.avatar}
              onValueChange={async (value) => {
                await save({ avatar: value });
              }}
              onImageSelected={handleAvatarImage}
            />
          </PopoverContent>
        </Popover>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-3">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => commit('title', title.trim(), agent.title ?? '')}
              placeholder={t`Agent title`}
              aria-label={t`Agent title`}
              className="h-auto min-w-0 flex-1 border-0 bg-transparent px-0 text-2xl font-semibold shadow-none focus-visible:ring-0"
            />
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => commit('name', name.trim(), agent.name ?? '')}
              placeholder={t`agent-name`}
              aria-label={t`Agent name`}
              className="h-7 w-48 shrink-0 border-0 bg-transparent px-0 text-end font-mono text-sm text-muted-foreground shadow-none focus-visible:ring-0"
            />
          </div>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => commit('description', description.trim(), agent.description ?? '')}
            placeholder={t`What is this agent for?`}
            aria-label={t`Description`}
            className="mt-1 min-h-0 resize-none border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
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
          <Button
            size="sm"
            disabled={!agent.enabled || using}
            onClick={() => void handleUse()}
            data-testid="agent-use"
          >
            {using ? (
              <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="me-1.5 h-3.5 w-3.5" />
            )}
            <Trans>Use</Trans>
          </Button>
        </div>
      </div>

      {/* ── body: the prompt owns the left, settings sit in a tabbed rail ── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="flex min-h-0 flex-col px-6 py-5">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">
              <Trans>Behaviour</Trans>
            </h2>
            <span className="text-xs text-muted-foreground">
              <Trans>Who this agent is — its system prompt.</Trans>
            </span>
          </div>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => commit('system_prompt', prompt, agent.system_prompt ?? '')}
            placeholder={t`Describe who this agent is, what it does, and what it must never do…`}
            aria-label={t`System prompt`}
            className="min-h-40 flex-1 resize-none font-mono text-sm leading-relaxed"
          />
        </section>

        <aside className="min-h-0 overflow-y-auto border-t border-border px-4 py-4 lg:border-s lg:border-t-0">
          <Tabs defaultValue="runtime">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="runtime">
                <Trans>Runtime</Trans>
              </TabsTrigger>
              <TabsTrigger value="deploy">
                <Trans>Deploy</Trans>
              </TabsTrigger>
              <TabsTrigger value="advanced">
                <Trans>Advanced</Trans>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="runtime" className="mt-4">
              <div className="grid grid-cols-2 gap-3">
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
                  placeholder={t`sm / md / lg`}
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
              </div>
              <div className="mt-4 flex items-center justify-between rounded-md border border-border px-3 py-2">
                <span className="text-sm">
                  <Trans>Load Flowpad assistant</Trans>
                </span>
                <Switch
                  checked={agent.load_flowpad_assistant}
                  onCheckedChange={(v) => void save({ load_flowpad_assistant: v })}
                  aria-label={t`Load Flowpad assistant`}
                />
              </div>
            </TabsContent>

            <TabsContent value="deploy" className="mt-4">
              <AgentDeploymentsSection agent={agent} />
            </TabsContent>

            <TabsContent value="advanced" className="mt-4">
              <section>
                <p className="mb-3 text-xs text-muted-foreground">
                  <Trans>Declared on the agent's card. Not yet applied to the worker.</Trans>
                </p>
                <div className="space-y-3">
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
                  {/* Skills and MCP servers are wired in the agent-resources
                      pane (Zone B), which lists what actually exists instead of
                      asking for typed ids. They are deliberately not duplicated
                      here — two editors for one field is how they drift. */}
                  <AgentListField
                    label={t`Additional directories`}
                    value={agent.additional_dirs}
                    onCommit={(v) => void save({ additional_dirs: v ?? [] })}
                  />
                </div>
              </section>
            </TabsContent>
          </Tabs>
        </aside>
      </div>
    </div>
  );
}
