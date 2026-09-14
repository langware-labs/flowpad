import { Agent, AGENT_AVATAR_FILE, AGENT_AVATAR_REF, FSRef, type AgentVersionState } from '@sdk';
import { isHubOnly } from '@sdk/utils/hub-runtime';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, UploadCloud } from 'lucide-react';

import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { errorMessage } from '@src/lib/error-message';
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

import { AgentPlacesColumn } from './AgentPlacesColumn';
import { AgentChoiceField, AgentListField, AgentSelectField } from './AgentProfileFields';
import { AgentMcpField } from './AgentMcpField';
import { AGENT_EFFORTS, AGENT_MODEL_TIERS, AGENT_PERMISSION_MODES, AGENT_WORKER_TYPES } from './agent-vocabularies';
import type { AgentDocumentPatch } from './agent-fields';
import { useMarkdownContent } from '@src/hooks/use-markdown-content';
import { DocumentSaveNotice } from '../DocumentSaveNotice';
import type { DocumentValue } from '@sdk/fs/AssetDocument';
import { entityReloadKey } from '@src/utils/entity-reload-key';

interface AgentProfileEditorProps {
  /** Always resolved — AssetEditorRouter renders this inside an
   *  EntityResolutionGate, which only calls render() with a non-null entity. */
  agent: Agent;
  /** Primary agent.md ref returned by the entity's record/refs action. */
  mainRef: FSRef;
}

/**
 * The agent page: a DEFINITION shared by every place, and the places it RUNS ON.
 *
 * The left column edits agent.md on this computer — the defaults every place
 * starts from. The right column lists each place (this computer, each cloud
 * machine) with what that place owns: its config overrides, schedules and email.
 * The header says what of the definition is not published yet.
 *
 * The entity record resolves the filesystem authority. The editor always patches
 * agent.md through the same revision-checked document action; the backend
 * preserves YAML and identity data.
 */
export function AgentProfileEditor({ agent, mainRef }: AgentProfileEditorProps) {
  const { t } = useLingui();
  const hub = isHubOnly();

  const agentRef = useRef(agent);
  agentRef.current = agent;
  const writeQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const content = useMarkdownContent(mainRef, { autoSave: false, reloadKey: entityReloadKey(agent.updated_date) });
  const contentRef = useRef(content);
  contentRef.current = content;
  const profile = content.typedFields as Partial<Agent>;
  const title = content.fields.title ?? '';
  const description = content.fields.description ?? '';
  const prompt = content.body;
  const intro = content.fields.intro ?? '';
  const autoLaunchPrompt = content.fields.auto_launch_prompt ?? '';
  const [avatarRevision, setAvatarRevision] = useState(0);
  const [version, setVersion] = useState<AgentVersionState | null>(null);
  const [publishing, setPublishing] = useState(false);

  const loadVersion = useCallback(async () => {
    if (hub) return;
    try {
      setVersion(await agentRef.current.versionState());
    } catch {
      setVersion(null);
    }
  }, [hub]);

  useEffect(() => {
    void loadVersion();
  }, [loadVersion, agent.updated_date]);

  const save = useCallback((patch: AgentDocumentPatch): Promise<boolean> => {
    const current = contentRef.current;
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'system_prompt') current.setBody(typeof value === 'string' ? value : '');
      else if (value === undefined) current.dropField(key);
      else current.setField(key, value as DocumentValue);
    }
    const operation = writeQueueRef.current.then(async () => {
      const saved = await contentRef.current.save();
      if (saved) agentRef.current.markEdit();
      return saved;
    });
    writeQueueRef.current = operation;
    return operation;
  }, []);

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
    <K extends keyof AgentDocumentPatch>(key: K, value: AgentDocumentPatch[K]) => {
      void save({ [key]: value } as AgentDocumentPatch);
    },
    [save],
  );

  const publish = useCallback(async () => {
    setPublishing(true);
    try {
      // Pending edits first: publishing must never push a stale file.
      await writeQueueRef.current;
      if (!(await contentRef.current.save())) return;
      await agentRef.current.publish({ force: true });
      notify.success({ title: t`Published` });
      await loadVersion();
    } catch (e) {
      notify.error({ title: t`Could not publish`, message: errorMessage(e, t`Publish failed.`), forceToast: true });
    } finally {
      setPublishing(false);
    }
  }, [loadVersion, t]);

  const identityKey = profile.name || agent.id;
  const ringColor = colorForIdentityKey(identityKey);
  const AgentIcon = iconForType(Agent.type);
  const avatarImageUrl =
    profile.avatar === AGENT_AVATAR_REF ? mainRef.parent.child(AGENT_AVATAR_FILE).getDownloadUrl() : null;
  const pending = version?.pending_changes ?? 0;
  const commitShort = version?.published_commit ? version.published_commit.slice(0, 7) : '';

  if (content.isLoading) return <Loader2 className="m-4 h-5 w-5 animate-spin" />;
  if (content.loadError)
    return (
      <div role="alert" className="p-4">
        {content.loadError.message}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DocumentSaveNotice {...content} />
      {/* ── header: identity + what is not published ─────────────────── */}
      <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-border px-6 py-5">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t`Change avatar`}
              className={cn(
                'flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full',
                'text-2xl text-white shadow-sm transition hover:opacity-90',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                ringColor,
              )}
            >
              <AgentAvatar
                key={`${profile.avatar ?? 'none'}:${avatarRevision}`}
                agent={agent}
                imageUrl={avatarImageUrl}
                className="h-full w-full bg-transparent text-2xl"
                glyphClassName="h-7 w-7 text-2xl"
                fallback={<AgentIcon className="h-7 w-7" />}
              />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3" align="start">
            <AgentAvatarPicker
              value={profile.avatar}
              onValueChange={async (value) => {
                await save({ avatar: value });
              }}
              onImageSelected={handleAvatarImage}
            />
          </PopoverContent>
        </Popover>

        <div className="min-w-[14rem] flex-1">
          <div className="flex items-baseline gap-3">
            <Input
              value={title}
              onChange={(e) => content.setField('title', e.target.value)}
              onBlur={() => commit('title', title.trim())}
              readOnly={hub}
              placeholder={t`Agent title`}
              aria-label={t`Agent title`}
              className="h-auto min-w-0 flex-1 border-0 bg-transparent px-0 text-2xl font-semibold shadow-none focus-visible:ring-0"
            />
          </div>
          <div
            className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
            data-testid="agent-version"
          >
            {hub ? (
              <Trans>Published version — edit it on the author's computer</Trans>
            ) : !version ? null : !version.has_repo ? (
              <Trans>Not in a git repository — can't be published</Trans>
            ) : version.published ? (
              <span>
                <Trans>Published</Trans> <code className="rounded bg-muted px-1 font-mono">{commitShort}</code>
              </span>
            ) : (
              <Trans>Not published yet</Trans>
            )}
            {!hub && pending > 0 && (
              <span
                className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-400"
                data-testid="agent-pending"
              >
                {pending === 1 ? t`1 change not published` : t`${pending} changes not published`}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {!hub && (
            <Button
              size="sm"
              disabled={publishing || !version?.has_repo || (version.published && pending === 0)}
              onClick={() => void publish()}
              data-testid="agent-publish"
            >
              {publishing ? (
                <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <UploadCloud className="me-1.5 h-3.5 w-3.5" />
              )}
              <Trans>Publish</Trans>
            </Button>
          )}
        </div>
      </div>

      {/* ── body: the definition on the left, where it runs on the right ── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_36rem] lg:overflow-hidden">
        <section
          className="flex min-h-0 flex-col gap-5 px-6 py-5 lg:overflow-y-auto"
          aria-labelledby="agent-definition"
        >
          {/* On the hub this is the PUBLISHED definition: read it here, edit it on the author's computer. */}
          <fieldset disabled={hub} className="contents" data-testid="agent-definition-fields">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="agent-definition" className="text-sm font-semibold">
                <Trans>Definition</Trans>
              </h2>
              <span className="text-xs text-muted-foreground">
                <Trans>Shared by every place</Trans>
              </span>
            </div>

            {/* shrink-0: opening "More" must scroll the column, not squeeze the prompt to nothing. */}
            <div className="flex shrink-0 flex-col">
              <label className="mb-1 text-xs text-muted-foreground" htmlFor="agent-system-prompt">
                <Trans>Behaviour — who this agent is, its system prompt</Trans>
              </label>
              <Textarea
                id="agent-system-prompt"
                value={prompt}
                onChange={(e) => content.setBody(e.target.value)}
                onBlur={() => commit('system_prompt', prompt)}
                placeholder={t`Describe who this agent is, what it does, and what it must never do…`}
                aria-label={t`System prompt`}
                className="min-h-48 resize-y font-mono text-sm leading-relaxed"
              />
            </div>

            <div>
              <div className="mb-2 text-xs text-muted-foreground">
                <Trans>Default config — a place can override any of these</Trans>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <AgentChoiceField
                  label={t`Worker`}
                  value={profile.worker_type}
                  options={AGENT_WORKER_TYPES}
                  onCommit={(v) => void save({ worker_type: v })}
                />
                <AgentSelectField
                  label={t`Model`}
                  value={profile.model}
                  options={AGENT_MODEL_TIERS}
                  placeholder={t`sm / md / lg`}
                  onCommit={(v) => void save({ model: v })}
                />
                <AgentSelectField
                  label={t`Permissions`}
                  value={profile.permission_mode}
                  options={AGENT_PERMISSION_MODES}
                  onCommit={(v) => void save({ permission_mode: v })}
                />
                <AgentSelectField
                  label={t`Effort`}
                  value={profile.effort}
                  options={AGENT_EFFORTS}
                  onCommit={(v) => void save({ effort: v })}
                />
              </div>
            </div>

            <AgentMcpField value={profile.mcp_servers} onCommit={(ids) => void save({ mcp_servers: ids })} />

            <details className="group rounded-md border border-border" data-testid="agent-more">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium">
                <ChevronRight className="h-3.5 w-3.5 transition group-open:rotate-90" />
                <Trans>More</Trans>
                <span className="text-xs font-normal text-muted-foreground">
                  <Trans>name · description · intro · auto-launch · Flowpad assistant · declared fields</Trans>
                </span>
              </summary>
              <div className="flex flex-col gap-4 border-t border-border px-3 py-3">
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">
                    <Trans>Name — the agent's folder name, used to address it</Trans>
                  </div>
                  <code className="font-mono text-sm" data-testid="agent-name">
                    {agent.name}
                  </code>
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">
                    <Trans>Description</Trans>
                  </div>
                  <Textarea
                    value={description}
                    onChange={(e) => content.setField('description', e.target.value)}
                    onBlur={() => commit('description', description.trim())}
                    placeholder={t`What is this agent for?`}
                    aria-label={t`Description`}
                    className="min-h-0 resize-none text-sm"
                    rows={2}
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">
                    <Trans>Intro — shown as the agent's first message, not sent to the model</Trans>
                  </div>
                  <Textarea
                    value={intro}
                    onChange={(e) => content.setField('intro', e.target.value)}
                    onBlur={() => commit('intro', intro.trim())}
                    placeholder={t`Welcome! Tell the user what this agent can do and how to start…`}
                    aria-label={t`Intro`}
                    data-testid="agent-intro-field"
                    className="min-h-16 resize-none text-sm"
                    rows={2}
                  />
                </div>
                <div className="rounded-md border border-border px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">
                      <Trans>Auto-launch on project open</Trans>
                    </span>
                    <Switch
                      checked={profile.auto_launch}
                      onCheckedChange={(v) => void save({ auto_launch: v })}
                      aria-label={t`Auto-launch on project open`}
                      data-testid="agent-auto-launch"
                    />
                  </div>
                  {profile.auto_launch ? (
                    <Textarea
                      value={autoLaunchPrompt}
                      onChange={(e) => content.setField('auto_launch_prompt', e.target.value)}
                      onBlur={() => commit('auto_launch_prompt', autoLaunchPrompt.trim())}
                      placeholder={t`First prompt to send when the project opens…`}
                      aria-label={t`Auto-launch prompt`}
                      data-testid="agent-auto-launch-prompt"
                      className="mt-2 min-h-16 resize-none text-sm"
                      rows={2}
                    />
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      <Trans>
                        Once per project, the first time it is opened. Oldest agent wins if several set this.
                      </Trans>
                    </p>
                  )}
                </div>
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <span className="text-sm">
                    <Trans>Load Flowpad assistant</Trans>
                  </span>
                  <Switch
                    checked={profile.load_flowpad_assistant}
                    onCheckedChange={(v) => void save({ load_flowpad_assistant: v })}
                    aria-label={t`Load Flowpad assistant`}
                  />
                </div>
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    <Trans>Declared on the agent's card. Not yet applied to the worker.</Trans>
                  </p>
                  <AgentSelectField
                    label={t`Max turns`}
                    value={profile.max_turns == null ? '' : String(profile.max_turns)}
                    placeholder={t`unlimited`}
                    onCommit={(v) => {
                      const n = v == null ? undefined : Number(v);
                      if (n !== undefined && Number.isNaN(n)) return;
                      void save({ max_turns: n });
                    }}
                  />
                  <AgentListField label={t`Tools`} value={profile.tools} onCommit={(v) => void save({ tools: v })} />
                  <AgentListField
                    label={t`Disallowed tools`}
                    value={profile.disallowed_tools}
                    onCommit={(v) => void save({ disallowed_tools: v })}
                  />
                  <AgentListField
                    label={t`Sub-agents`}
                    value={profile.subagents}
                    onCommit={(v) => void save({ subagents: v ?? [] })}
                  />
                  <AgentListField
                    label={t`Additional directories`}
                    value={profile.additional_dirs}
                    onCommit={(v) => void save({ additional_dirs: v ?? [] })}
                  />
                </div>
              </div>
            </details>
          </fieldset>
        </section>

        <aside className="min-h-0 border-t border-border bg-muted/20 px-5 py-5 lg:overflow-y-auto lg:border-s lg:border-t-0">
          <AgentPlacesColumn agent={agent} autoLaunchPrompt={autoLaunchPrompt} pendingChanges={pending} />
        </aside>
      </div>
    </div>
  );
}
