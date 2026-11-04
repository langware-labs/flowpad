import { Agent, AGENT_AVATAR_FILE, AGENT_AVATAR_REF, FSRef, TypeId, type AgentVersionState } from '@sdk';
import { useAgentPlaces } from './use-agent-places';
import { isHubOnly } from '@sdk/utils/hub-runtime';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MessageCircle, Trash2 } from 'lucide-react';
import { useAgentLauncher } from '@src/components/agents/use-agent-launcher';

import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { errorMessage } from '@src/lib/error-message';
import { AgentAvatar } from '@src/components/agents/AgentAvatar';
import { AgentAvatarPicker } from '@src/components/ui/agent-avatar-picker';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { prepareAvatarImage } from '@src/lib/prepare-avatar-image';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { MilkdownEditor } from '@src/components/milkdown-editor/MilkdownEditor';
import { FullScreenButton, FullScreenView } from '@src/components/ui/full-screen';
import { Switch } from '@src/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Button } from '@src/components/ui/button';

import { AttachedChannelsBar, useAttachedChannels } from '@src/components/stream-inbox-view/AttachedChannelsBar';
import { AddIntroTranslationButton, IntroTranslationFields } from './AgentIntroTranslations';
import { AgentPlacesColumn } from './AgentPlacesColumn';
import { AgentRequestLine } from './AgentRequestLine';
import { AgentListField, AgentPhoneField, AgentSelectField } from './AgentProfileFields';
import { AgentAssistantSkillsField } from './AgentAssistantSkillsField';
import { AgentModelSizeField } from './AgentModelSizeField';
import { AgentVisibilitySection } from './AgentVisibilitySection';
import { useAgentMcpSync } from './use-agent-mcp-sync';
import { invalidateGitPreflight } from '@src/hooks/use-git-share-preflight';
import type { AgentDocumentPatch } from './agent-fields';
import { useMarkdownContent } from '@src/hooks/use-markdown-content';
import { DocumentSaveNotice } from '../DocumentSaveNotice';
import type { DocumentValue } from '@sdk/fs/AssetDocument';
import { entityReloadKey } from '@src/utils/entity-reload-key';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { useNestedHost } from '../nested-host';

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
  const { launch, busyId } = useAgentLauncher();

  const agentRef = useRef(agent);
  agentRef.current = agent;
  const { navigation, currentDock } = useDockNavigation();
  const nested = useNestedHost();
  const onDelete = useCallback(() => {
    showDeleteAssetModal({
      name: agentRef.current.title || agentRef.current.name || t`this agent`,
      onConfirm: async () => {
        await agentRef.current.delete();
      },
      // Nested in another editor: back to it, not to the agent list.
      onAfterDelete: () => (nested ? nested.close() : navigation.openDock(DockPointer.forAssetList(Agent.type))),
    });
  }, [navigation, nested, t]);
  const writeQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const content = useMarkdownContent(mainRef, { autoSave: false, reloadKey: entityReloadKey(agent.updated_date) });
  const contentRef = useRef(content);
  contentRef.current = content;
  const profile = content.typedFields as Partial<Agent>;
  const title = content.fields.title ?? '';
  const description = content.fields.description ?? '';
  const prompt = content.body;
  const intro = content.fields.intro ?? '';
  const introTranslations = profile.intro_translations ?? {};
  const autoPrompt = content.fields.auto_launch_prompt ?? '';
  const [avatarRevision, setAvatarRevision] = useState(0);
  const [version, setVersion] = useState<AgentVersionState | null>(null);
  // The channels people reach this agent on, drawn in the header the way the stream inbox header
  // draws them: one mark per attached channel, the featured ones still to connect, and "+". A mark
  // opens the agent's stream inbox on that channel — there is no list here to narrow.
  const channelsOwner = useMemo(() => new TypeId(Agent.type, agent.id), [agent.id]);
  const {
    rows: channelRows,
    specFor: channelSpecFor,
    offers: channelOffers,
  } = useAttachedChannels(hub ? null : channelsOwner);
  const openChannel = useCallback(
    (key: string) => navigation.openDock(DockPointer.forAgentStreamInbox(agent.id, { channel: key })),
    [navigation, agent.id],
  );
  // Sharing reads its public grant from the hub on mount; hold it back until "More" is first opened.
  const [moreOpened, setMoreOpened] = useState(false);
  const [promptFull, setPromptFull] = useState(false);
  // Milkdown rebuilds on a new onChange, so keep the callback stable and read the latest body from a ref.
  const setBodyRef = useRef(content.setBody);
  setBodyRef.current = content.setBody;
  const onPromptChange = useCallback((md: string) => setBodyRef.current(md), []);

  const loadVersion = useCallback(async () => {
    if (hub) return;
    try {
      setVersion(await agentRef.current.versionState());
    } catch {
      setVersion(null);
    }
  }, [hub]);

  // A deploy publishes the agent without touching its row, so the header follows the deployments too:
  // without this it still said "Not published yet" after a cloud deploy, until the page was reopened.
  const { places } = useAgentPlaces(hub ? null : agent);
  const placesKey = places
    ? places.map((p) => `${p.deployment.id}:${String(p.deployment.status ?? '')}:${p.behind ?? ''}`).join(',')
    : '';
  useEffect(() => {
    void loadVersion();
  }, [loadVersion, agent.updated_date, placesKey]);

  // Has this agent already used its once-per-project auto-launch? Local only:
  // the mark lives on this computer, beside the project.
  const [autoLaunched, setAutoLaunched] = useState<boolean | null>(null);
  const [resettingLaunch, setResettingLaunch] = useState(false);
  useEffect(() => {
    if (hub) return setAutoLaunched(null);
    let live = true;
    agentRef.current
      .autoLaunchState()
      .then((state) => live && setAutoLaunched(state.launched))
      .catch(() => live && setAutoLaunched(null));
    return () => {
      live = false;
    };
  }, [hub, agent.id]);

  const resetAutoLaunch = useCallback(async () => {
    setResettingLaunch(true);
    try {
      await agentRef.current.resetAutoLaunch();
      setAutoLaunched(false);
      notify.success({ title: t`Auto-launch reset`, message: t`It runs again the next time the project opens.` });
    } catch (e) {
      notify.error({ title: t`Could not reset auto-launch`, message: errorMessage(e, t`Reset failed.`) });
    } finally {
      setResettingLaunch(false);
    }
  }, [t]);

  const save = useCallback((patch: AgentDocumentPatch): Promise<boolean> => {
    const current = contentRef.current;
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'system_prompt') current.setBody(typeof value === 'string' ? value : '');
      else if (value === undefined) current.dropField(key);
      else current.setField(key, value as DocumentValue);
    }
    const operation = writeQueueRef.current.then(async () => {
      // A save with nothing changed writes nothing, so it is not an edit: no recency stamp and no
      // git re-check (a blur on an untouched field used to stamp the agent as edited).
      const wrote = contentRef.current.isDirty();
      const saved = await contentRef.current.save();
      if (saved && wrote) {
        agentRef.current.markEdit();
        // A saved agent.md in a git checkout is auto-committed server-side
        // (`asset_versioning`), which moves the branch ahead of its remote with
        // no event of its own. Say so on the preflight channel, so the Git share
        // surfaces re-ask instead of claiming nothing is pending.
        invalidateGitPreflight(agentRef.current.typeId);
      }
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
  // Every MCP server in the project is attached (the temporary policy); the list itself is shown in
  // the agent-resources menu, not here.
  const commitMcp = useCallback((ids: string[]) => void save({ mcp_servers: ids }), [save]);
  useAgentMcpSync(profile.mcp_servers, commitMcp, !hub);

  const commit = useCallback(
    <K extends keyof AgentDocumentPatch>(key: K, value: AgentDocumentPatch[K]) => {
      void save({ [key]: value } as AgentDocumentPatch);
    },
    [save],
  );

  const AgentIcon = iconForType(Agent.type);
  // Save the prompt when focus leaves its editor box (not when it moves inside it).
  const commitPromptOnLeave = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit('system_prompt', prompt);
  };
  const avatarImageUrl =
    profile.avatar === AGENT_AVATAR_REF ? mainRef.parent.child(AGENT_AVATAR_FILE).getDownloadUrl() : null;
  const pending = version?.pending_changes ?? 0;
  const commitShort = version?.published_commit ? version.published_commit.slice(0, 7) : '';

  if (content.isLoading) return <Loader2 className="m-4 h-5 w-5 animate-spin" />;
  // An unreadable definition (a hub that serves no agent document) fails only the definition column:
  // the deployments beside it come from the agent row, not from this file.
  const definitionError = content.loadError;
  const promptMode = hub || definitionError ? 'view' : 'editor';
  const promptEditor = (toolbarRight?: React.ReactNode) => (
    <MilkdownEditor content={prompt} onChange={onPromptChange} editorMode={promptMode} toolbarRight={toolbarRight} />
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
              )}
            >
              <AgentAvatar
                key={`${profile.avatar ?? 'none'}:${avatarRevision}`}
                agent={agent}
                imageUrl={avatarImageUrl}
                // null, not undefined: undefined would fall back to the saved row, not the draft.
                color={profile.color ?? null}
                className="h-full w-full text-2xl"
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
              color={profile.color}
              onColorChange={(color) => void save({ color: color ?? undefined })}
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
            ) : !version ? null : version.published ? (
              <span>
                <Trans>Published</Trans>
                {commitShort && (
                  <>
                    {' '}
                    <code className="rounded bg-muted px-1 font-mono">{commitShort}</code>
                  </>
                )}
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
            {!hub && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void launch(agent, currentDock?.scopeProjectId ?? null)}
                disabled={busyId === agent.id || agent.enabled === false}
                data-testid="agent-chat"
                className="h-6 shrink-0 gap-1 px-2 text-xs"
              >
                {busyId === agent.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <MessageCircle className="h-3.5 w-3.5" />
                )}
                <Trans>Chat</Trans>
              </Button>
            )}
          </div>
          {!hub && (
            <div className="mt-2" data-testid="agent-header-channels">
              <AttachedChannelsBar
                owner={channelsOwner}
                rows={channelRows}
                specFor={channelSpecFor}
                offers={channelOffers}
                onMarkPress={openChannel}
              />
            </div>
          )}
        </div>
        {!hub && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onDelete}
            aria-label={t`Delete agent`}
            title={t`Delete agent`}
            data-testid="agent-delete"
            className="shrink-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* ── body: the definition on the left, where it runs on the right ── */}
      <div className="flex min-h-0 flex-1 flex-col">
        <section
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5"
          aria-labelledby="agent-definition"
        >
          {/* On the hub this is the PUBLISHED definition: read it here, edit it on the author's computer. */}
          <fieldset disabled={hub || !!definitionError} className="contents" data-testid="agent-definition-fields">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="agent-definition" className="text-sm font-semibold">
                <Trans>Definition</Trans>
              </h2>
            </div>
            {definitionError && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="agent-definition-error"
              >
                <Trans>Could not load the agent's definition: {definitionError.message}</Trans>
              </div>
            )}
          </fieldset>

          <Tabs
            defaultValue="instructions"
            className="flex min-h-0 flex-1 flex-col"
            onValueChange={(v) => v === 'settings' && setMoreOpened(true)}
          >
            <TabsList className="self-start">
              <TabsTrigger value="instructions" data-testid="agent-tab-instructions">
                <Trans>Instructions</Trans>
              </TabsTrigger>
              <TabsTrigger value="settings" data-testid="agent-tab-settings">
                <Trans>Settings</Trans>
              </TabsTrigger>
              <TabsTrigger value="deployments" data-testid="agent-tab-deployments">
                <Trans>Deployments</Trans>
                {places && places.length > 0 && (
                  <span
                    className="ms-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums leading-none text-primary-foreground"
                    data-testid="agent-tab-deployments-count"
                  >
                    {places.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
            <TabsContent
              value="instructions"
              className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
            >
              <span className="mb-1 text-xs text-muted-foreground">
                <Trans>Behaviour — who this agent is, its system prompt</Trans>
              </span>
              <div
                className="min-h-48 flex-1 overflow-y-auto rounded-md border border-input text-sm"
                aria-label={t`System prompt`}
                data-testid="agent-system-prompt"
                onBlur={commitPromptOnLeave}
              >
                {/* One editor at a time: while full screen is open, the prompt is edited there. */}
                {!promptFull &&
                  promptEditor(<FullScreenButton className="ms-auto" onClick={() => setPromptFull(true)} />)}
              </div>
              <FullScreenView
                open={promptFull}
                onExit={() => {
                  setPromptFull(false);
                  commit('system_prompt', prompt);
                }}
                title={title || agent.name}
                subtitle={<Trans>Instructions — the agent's system prompt</Trans>}
                icon={
                  <AgentAvatar
                    agent={agent}
                    imageUrl={avatarImageUrl}
                    color={profile.color ?? null}
                    className="h-9 w-9 shrink-0"
                    glyphClassName="h-5 w-5 text-lg"
                    fallback={<AgentIcon className="h-5 w-5" />}
                  />
                }
              >
                <div
                  className="flex min-h-0 flex-1 flex-col overflow-y-auto text-sm"
                  data-testid="agent-system-prompt-full"
                  onBlur={commitPromptOnLeave}
                >
                  {promptEditor()}
                </div>
              </FullScreenView>
            </TabsContent>
            {/* Kept mounted so a settings draft survives switching tabs. */}
            <TabsContent
              value="settings"
              forceMount
              className="mt-3 data-[state=inactive]:hidden"
              data-testid="agent-more"
            >
              <div className="flex flex-col gap-4">
                <fieldset disabled={hub || !!definitionError} className="contents" data-testid="agent-more-fields">
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
                    <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <Trans>Intro — shown as the agent's first message, not sent to the model</Trans>
                      <AddIntroTranslationButton
                        translations={introTranslations}
                        onAdd={(code) => content.setField('intro_translations', { ...introTranslations, [code]: '' })}
                      />
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
                    <IntroTranslationFields
                      translations={introTranslations}
                      onChange={(next) => content.setField('intro_translations', next)}
                      onCommit={(next) => commit('intro_translations', next)}
                    />
                  </div>
                  <AgentPhoneField
                    label={t`Phone number — recorded on the agent's card, not yet used to route messages`}
                    value={profile.phone}
                    onCommit={(v) => void save({ phone: v })}
                  />
                  {/* Its own setting: sent on every new session, not only an auto-launch.
                    Stored as `auto_launch_prompt` — AgentSpec forbids unknown keys. */}
                  <div>
                    <div className="mb-1 text-xs text-muted-foreground">
                      <Trans>Auto prompt — sent as the first message of every new session with this agent</Trans>
                    </div>
                    <Textarea
                      value={autoPrompt}
                      onChange={(e) => content.setField('auto_launch_prompt', e.target.value)}
                      onBlur={() => commit('auto_launch_prompt', autoPrompt.trim())}
                      placeholder={t`First message to send when a session starts…`}
                      aria-label={t`Auto prompt`}
                      data-testid="agent-auto-prompt"
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
                    <p className="mt-1 text-xs text-muted-foreground">
                      <Trans>
                        Once per project, the first time it is opened. Enabling this turns off auto-launch for the other
                        agents in this project.
                      </Trans>
                    </p>
                    {autoLaunched !== null ? (
                      <div
                        className="mt-2 flex items-center justify-between gap-2"
                        data-testid="agent-auto-launch-status"
                      >
                        <span className="text-xs text-muted-foreground">
                          {autoLaunched ? (
                            <Trans>Already launched in this project</Trans>
                          ) : (
                            <Trans>Not launched yet in this project</Trans>
                          )}
                        </span>
                        {autoLaunched ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={resettingLaunch}
                            onClick={() => void resetAutoLaunch()}
                            data-testid="agent-auto-launch-reset"
                          >
                            {resettingLaunch ? <Loader2 className="size-3.5 animate-spin" /> : null}
                            <Trans>Reset</Trans>
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="rounded-md border border-border px-3 py-2" data-testid="agent-vibe-only">
                    <div className="flex items-center justify-between">
                      <span className="text-sm">
                        <Trans>Vibe only</Trans>
                      </span>
                      <Switch
                        checked={!!profile.vibe_only}
                        onCheckedChange={(v) => void save({ vibe_only: v })}
                        aria-label={t`Vibe only`}
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <Trans>
                        Sessions with this agent stay in Vibe: no tabs, and no switch to Chat or Terminal. New sessions
                        are reached from Recent.
                      </Trans>
                    </p>
                  </div>
                  <AgentModelSizeField value={profile.model} onCommit={(v) => void save({ model: v })} />
                  <div className="rounded-md border border-border px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm">
                        <Trans>Load Flowpad assistant</Trans>
                      </span>
                      <Switch
                        checked={profile.load_flowpad_assistant}
                        onCheckedChange={(v) => void save({ load_flowpad_assistant: v })}
                        aria-label={t`Load Flowpad assistant`}
                      />
                    </div>
                    {profile.load_flowpad_assistant ? (
                      <AgentAssistantSkillsField
                        agent={agent}
                        value={profile.assistant_skills}
                        onCommit={(v) => void save({ assistant_skills: v })}
                      />
                    ) : null}
                  </div>
                  <div
                    className="space-y-2 rounded-md border border-border px-3 py-2"
                    data-testid="agent-chief-of-staff"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm">
                        <Trans>Chief of Staff</Trans>
                      </span>
                      <Switch
                        checked={!!profile.chief_of_staff}
                        onCheckedChange={(v) => void save({ chief_of_staff: v })}
                        aria-label={t`Chief of Staff`}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <Trans>
                        Answers fast and hands longer work to its staff as tasks. Their progress arrives on the agent's
                        Tasks channel; only the agent talks to people.
                      </Trans>
                    </p>
                    {profile.chief_of_staff ? (
                      <AgentListField
                        label={t`Staff (sub-agents; the general worker is always there)`}
                        value={profile.subagents}
                        onCommit={(v) => void save({ subagents: v ?? [] })}
                      />
                    ) : null}
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
                      label={t`Additional directories`}
                      value={profile.additional_dirs}
                      onCommit={(v) => void save({ additional_dirs: v ?? [] })}
                    />
                  </div>
                </fieldset>
                {/* Sharing and the public grant land on the published hub row — nothing to toggle on the hub's own
                  read-only view. Outside the definition's fieldsets: an unreadable agent document must not
                  disable controls that never touch it. */}
                {!hub && moreOpened && (
                  <AgentVisibilitySection agent={agent} version={version} onPublished={loadVersion} />
                )}
              </div>
            </TabsContent>
            <TabsContent value="deployments" className="mt-3">
              <AgentPlacesColumn agent={agent} />
            </TabsContent>
          </Tabs>
        </section>
      </div>
      {!hub && <AgentRequestLine agent={agent} displayName={title || (agent.name ?? '')} />}
    </div>
  );
}
