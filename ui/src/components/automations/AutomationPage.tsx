/**
 * One automation — or a new one — as a sentence you build: When · Then, with
 * Test beside it and its Runs one tab away.
 *
 * Simple first: presets, a picker, a prompt. Advanced is one click inside each
 * block (cron, time zone, event pattern) and at the bottom of the page (fire
 * once, storm guard, the raw fields as JSON, an agent rule's code).
 *
 * A file-defined automation saves to its trigger.json (the backend routes it);
 * Flowpad's own are read-only here but can still be checked and run.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { AutomationKind, ITrigger } from '@sdk';
import { ArrowLeft, CheckCircle2, FileJson, FlaskConical, FolderOpen, Lock, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Input } from '@src/components/ui/input';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';
import {
  useAutomation,
  useAutomationRuns,
  useAutomationTrigger,
  useDeleteAutomation,
  useDiscoverRules,
  useRuleCode,
  useSaveAutomation,
  useSetAutomationEnabled,
} from '@src/hooks/automations/useAutomations';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { defaultDraft, draftFromTrigger, draftProblems, draftToFields, type AutomationDraft } from './automation-draft';
import { recipeById } from './automation-recipes';
import { sentenceText, useAutomationWords } from './automation-words';
import type { AutomationsRoute } from './automations-pointer';
import { ThenBlock } from './blocks/ThenBlock';
import { Advanced, Block, WhenBlock } from './blocks/WhenBlock';
import { RunDetail } from './RunDetail';
import { RunsList } from './RunsList';
import { TestPanel } from './TestPanel';
import { definitionFile, useAutomationOpen } from './use-automation-open';
import { ThenSteps } from './ThenSteps';

export function AutomationPage({ route }: { route: AutomationsRoute }) {
  const { t } = useLingui();
  const words = useAutomationWords();
  const { navigation } = useDockNavigation();
  const triggerId = route.trigger ?? null;
  const isNew = !triggerId;
  const { automation } = useAutomation(triggerId);
  const triggerQuery = useAutomationTrigger(triggerId);
  const save = useSaveAutomation();
  const remove = useDeleteAutomation();
  const setEnabled = useSetAutomationEnabled();
  const open = useAutomationOpen();

  // The draft is loaded ONCE per automation (or per new kind + starter): the list
  // polls, and re-seeding on every poll would wipe what the person is typing.
  const loadKey = isNew ? `new:${route.creating}:${route.recipe ?? ''}:${route.tag ?? ''}` : `id:${triggerId}`;
  const [loaded, setLoaded] = useState<{ key: string; base: AutomationDraft; draft: AutomationDraft } | null>(null);
  useEffect(() => {
    if (loaded?.key === loadKey) return;
    let base: AutomationDraft | null = null;
    if (isNew) {
      base = recipeById(route.recipe)?.draft() ?? defaultDraft((route.creating ?? 'schedule') as AutomationKind);
      // Started from the event bus: the event is already chosen.
      if (route.tag && base.kind === 'event') base = { ...base, event: { ...base.event, pattern: route.tag } };
    } else if (triggerQuery.data && automation)
      base = draftFromTrigger(triggerQuery.data as ITrigger, automation.when.schedule);
    if (base) setLoaded({ key: loadKey, base, draft: base });
  }, [loadKey, loaded?.key, isNew, route.creating, route.recipe, route.tag, triggerQuery.data, automation]);

  const draft = loaded?.draft ?? null;
  const setDraft = (next: AutomationDraft) => setLoaded((l) => (l ? { ...l, draft: next } : l));
  const fields = useMemo(() => (draft ? draftToFields(draft) : null), [draft]);
  const baseFields = useMemo(() => (loaded ? JSON.stringify(draftToFields(loaded.base)) : ''), [loaded?.base]);
  const dirty = !!fields && JSON.stringify(fields) !== baseFields;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const readOnly = !!automation?.read_only;
  const isRuleFolder = !!triggerQuery.data?.path && automation?.kind === 'agent_hook';
  const tab = route.tab ?? 'setup';
  const runs = useAutomationRuns({ triggerId, limit: 100 }, { enabled: !!triggerId && tab === 'runs' });
  const go = (patch: Partial<AutomationsRoute>) =>
    navigation.openDock(DockPointer.forAutomations({ ...route, ...patch }));

  if (route.creating === 'agent_hook' && isNew)
    return <AgentRulesExplainer onBack={() => go({ creating: null, recipe: null })} />;
  if (!draft || !fields) {
    return (
      <div className="p-6 text-sm text-muted-foreground" data-testid="automation-page-loading">
        {triggerQuery.error ? (
          errorMessage(triggerQuery.error, t`Could not load this automation`)
        ) : (
          <Trans>Loading…</Trans>
        )}
      </div>
    );
  }

  const problems = draftProblems(draft);
  const problemWords: Record<string, string> = {
    pattern: t`Pick the event to listen for.`,
    path: t`Pick the file or folder to watch.`,
    agent: t`Pick the agent to run.`,
    prompt: t`Write what the agent should do.`,
    script: t`Pick the script to run.`,
    cron: t`A cron expression has five parts.`,
    events: t`Pick at least one agent activity.`,
  };

  const doSave = async (): Promise<string | null> => {
    if (problems.length) {
      notify.error({
        title: t`Not ready to save`,
        message: problems.map((p) => problemWords[p]).join(' '),
        forceToast: true,
      });
      return null;
    }
    try {
      const saved = await save.mutateAsync({ triggerId, fields });
      setLoaded((l) => (l ? { ...l, base: l.draft } : l));
      if (isNew && saved.id) navigation.openDock(DockPointer.forAutomations({ trigger: saved.id }));
      notify.success({ title: isNew ? t`Automation created` : t`Saved`, message: fields.name });
      return saved.id ?? triggerId;
    } catch (e) {
      notify.error({ title: t`Could not save`, message: errorMessage(e, t`Save failed`), forceToast: true });
      return null;
    }
  };

  const onToggle = (on: boolean) => {
    if (isNew) return setDraft({ ...draft, enabled: on });
    setEnabled.mutate(
      { triggerId: triggerId as string, enabled: on },
      {
        onSuccess: () =>
          setLoaded((l) => (l ? { ...l, base: { ...l.base, enabled: on }, draft: { ...l.draft, enabled: on } } : l)),
        onError: (e) =>
          notify.error({ title: t`Could not change it`, message: errorMessage(e, t`Update failed`), forceToast: true }),
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="automation-page" data-automation-id={triggerId ?? 'new'}>
      <header className="flex flex-col gap-3 border-b border-border px-6 pb-3 pt-4">
        <button
          type="button"
          onClick={() => navigation.openDock(DockPointer.forAutomations())}
          className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          data-testid="automation-back"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          <Trans>Automations</Trans>
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            checked={draft.enabled}
            onCheckedChange={onToggle}
            disabled={readOnly || setEnabled.isPending}
            aria-label={draft.enabled ? t`Turn off` : t`Turn on`}
            data-testid="automation-page-toggle"
          />
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            disabled={readOnly}
            placeholder={t`Name it, or leave it and one is made up`}
            className="h-9 max-w-md flex-1 text-base font-medium"
            data-testid="automation-name"
          />
          {!isNew &&
            automation &&
            !readOnly &&
            (automation.tested && !dirty ? (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-emerald-500/50 bg-emerald-500/10 px-2 py-0.5 text-xs"
                data-testid="automation-tested"
              >
                <CheckCircle2 className="size-3.5" aria-hidden />
                <Trans>Tested</Trans>
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground"
                data-testid="automation-untested"
              >
                <FlaskConical className="size-3.5" aria-hidden />
                <Trans>Not tested yet</Trans>
              </span>
            ))}
          {readOnly && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
              <Lock className="size-3" aria-hidden />
              <Trans>Built into Flowpad</Trans>
            </span>
          )}
          <span className="flex-1" />
          {!readOnly && (
            <Button
              onClick={() => void doSave()}
              disabled={save.isPending || (!dirty && !isNew)}
              className="gap-1.5"
              data-testid="automation-save"
            >
              <Save className="size-4" aria-hidden />
              {isNew ? <Trans>Create</Trans> : <Trans>Save</Trans>}
            </Button>
          )}
          {!isNew && !readOnly && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setConfirmDelete(true)}
              aria-label={t`Delete`}
              data-testid="automation-delete"
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          )}
        </div>
        {!isNew && automation?.description && (
          <p className="max-w-3xl text-sm" data-testid="automation-description">
            {automation.description}
          </p>
        )}
        {!isNew && automation && !dirty && (
          <p className="text-sm text-muted-foreground" data-testid="automation-sentence">
            {sentenceText(words, automation.when, automation.then)}
          </p>
        )}
        {!isNew && automation && (
          // What it is made of, one click away: its file, and what it watches.
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {definitionFile(automation) && (
              <button
                type="button"
                onClick={() => open.openDefinition(automation)}
                className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
                data-testid="automation-open-definition"
              >
                <FileJson className="size-3.5" aria-hidden />
                <Trans>Open trigger.json</Trans>
              </button>
            )}
            {automation.kind === 'file' && automation.when.file?.path && (
              <button
                type="button"
                onClick={() => open.browseWatched(automation)}
                className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
                title={automation.when.file.path}
                data-testid="automation-browse-watched"
              >
                <FolderOpen className="size-3.5" aria-hidden />
                {automation.when.file.is_folder ? (
                  <Trans>Browse the watched folder</Trans>
                ) : (
                  <Trans>Open the watched file</Trans>
                )}
              </button>
            )}
          </div>
        )}
        {!isNew && (
          <div className="flex gap-4 text-sm" role="tablist">
            {(['setup', 'runs'] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                data-testid={`automation-tab-${key}`}
                onClick={() => go({ tab: key, run: null })}
                className={cn(
                  '-mb-3 border-b-2 pb-2',
                  tab === key
                    ? 'border-primary font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {key === 'setup' ? (
                  <Trans>Setup</Trans>
                ) : runs.data ? (
                  <Trans>Runs ({runs.data.length})</Trans>
                ) : (
                  <Trans>Runs</Trans>
                )}
              </button>
            ))}
          </div>
        )}
      </header>

      {tab === 'runs' && !isNew ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(16rem,2fr)_3fr]">
          <div className="min-h-0 overflow-auto border-r border-border">
            <RunsList
              runs={runs.data ?? []}
              hideName
              selectedId={route.run}
              onSelect={(r) => go({ tab: 'runs', run: r.id })}
              emptyText={<Trans>It has not run yet. Use Run once now on the Setup tab to try it.</Trans>}
            />
          </div>
          <div className="min-h-0 overflow-auto">
            {route.run ? (
              <RunDetail runId={route.run} fallback={runs.data?.find((r) => r.id === route.run)} />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">
                <Trans>Pick a run to see why it ran and what happened.</Trans>
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="grid gap-5 px-6 py-5 lg:grid-cols-[minmax(0,3fr)_minmax(16rem,2fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              {readOnly && (
                <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  <Trans>Flowpad runs this one itself. You can check it, run it and see its runs, not change it.</Trans>
                </p>
              )}
              {problems.length > 0 && !readOnly && (dirty || isNew) && (
                <ul
                  className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
                  data-testid="automation-problems"
                >
                  {problems.map((p) => (
                    <li key={p}>{problemWords[p]}</li>
                  ))}
                </ul>
              )}
              <WhenBlock draft={draft} onChange={setDraft} readOnly={readOnly || isRuleFolder} />
              {isRuleFolder ? (
                <RuleCodeBlock triggerId={triggerId as string} />
              ) : readOnly && automation ? (
                // Nothing to edit: say what it does, and let each step be opened.
                <Block testId="automation-then" title={<Trans>Then</Trans>}>
                  <ThenSteps steps={automation.then} />
                </Block>
              ) : (
                <ThenBlock draft={draft} onChange={setDraft} readOnly={readOnly} savedThen={automation?.then} />
              )}
              <Block testId="automation-advanced" title={<Trans>More</Trans>}>
                <Advanced testId="automation-advanced-toggle">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.advanced.fireOnce}
                      disabled={readOnly}
                      onChange={(e) =>
                        setDraft({ ...draft, advanced: { ...draft.advanced, fireOnce: e.target.checked } })
                      }
                      data-testid="automation-fire-once"
                    />
                    <Trans>Run only once, ever</Trans>
                  </label>
                  {draft.kind === 'event' && (
                    <label className="flex flex-wrap items-center gap-2 text-sm">
                      <Trans>Skip runs beyond</Trans>
                      <Input
                        type="number"
                        min={1}
                        className="h-8 w-20"
                        value={draft.advanced.maxFiresPerMinute ?? ''}
                        disabled={readOnly}
                        placeholder="60"
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            advanced: { ...draft.advanced, maxFiresPerMinute: Number(e.target.value) || null },
                          })
                        }
                      />
                      <Trans>a minute</Trans>
                    </label>
                  )}
                  <div>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      data-testid="automation-json-toggle"
                      onClick={() => {
                        setShowJson((s) => !s);
                        setJsonText(JSON.stringify(fields, null, 2));
                        setJsonError(null);
                      }}
                    >
                      {showJson ? <Trans>Hide the fields as JSON</Trans> : <Trans>Edit the fields as JSON</Trans>}
                    </button>
                    {showJson && (
                      <div className="mt-2 flex flex-col gap-2">
                        <Textarea
                          value={jsonText}
                          onChange={(e) => setJsonText(e.target.value)}
                          rows={12}
                          className="font-mono text-xs"
                          disabled={readOnly}
                          data-testid="automation-json"
                        />
                        {jsonError && (
                          <p className="rounded border border-red-500/60 bg-red-500/10 px-2 py-1 text-xs">
                            {jsonError}
                          </p>
                        )}
                        {!readOnly && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-fit"
                            data-testid="automation-json-apply"
                            onClick={() => {
                              try {
                                const parsed = JSON.parse(jsonText) as ITrigger;
                                const next = draftFromTrigger(parsed, null);
                                // A schedule's preset comes from the backend's reading; JSON is the raw form.
                                if (next.kind === 'schedule')
                                  next.schedule = { ...next.schedule, preset: 'cron', cron: parsed.expr ?? '' };
                                setDraft(next);
                                setJsonError(null);
                              } catch (e) {
                                setJsonError(errorMessage(e, t`That is not valid JSON.`));
                              }
                            }}
                          >
                            <Trans>Apply</Trans>
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </Advanced>
              </Block>
            </div>
            <div className="min-w-0">
              <TestPanel
                triggerId={triggerId}
                spec={fields}
                dirty={dirty || isNew}
                isEvent={draft.kind === 'event'}
                onSaveFirst={readOnly ? undefined : doSave}
                onRunStarted={() =>
                  notify.success({ title: t`Running it once`, message: t`Follow it on the Runs tab.` })
                }
              />
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t`Delete this automation?`}
        description={
          automation?.asset_ref
            ? t`Its folder is removed too. Past runs stay in the history.`
            : t`Past runs stay in the history.`
        }
        confirmLabel={t`Delete`}
        variant="destructive"
        onConfirm={() =>
          remove.mutate(triggerId as string, {
            onSuccess: () => navigation.openDock(DockPointer.forAutomations()),
            onError: (e) =>
              notify.error({
                title: t`Could not delete`,
                message: errorMessage(e, t`Delete failed`),
                forceToast: true,
              }),
          })
        }
      />
    </div>
  );
}

function RuleCodeBlock({ triggerId }: { triggerId: string }) {
  const { t } = useLingui();
  const code = useRuleCode(triggerId);
  const [text, setText] = useState<string | null>(null);
  const value = text ?? code.data ?? '';
  return (
    <Block testId="automation-rule-code" title={<Trans>Then: run its rule code</Trans>}>
      <p className="text-xs text-muted-foreground">
        <Trans>This agent rule decides in code what to do. It runs for every matching agent event.</Trans>
      </p>
      <Advanced testId="automation-rule-code-toggle">
        {code.error ? (
          <p className="text-xs text-muted-foreground">{errorMessage(code.error, t`No rule code to show.`)}</p>
        ) : (
          <>
            <Textarea
              value={value}
              onChange={(e) => setText(e.target.value)}
              rows={14}
              className="font-mono text-xs"
              data-testid="automation-rule-code-text"
            />
            <Button
              size="sm"
              variant="outline"
              className="w-fit"
              disabled={text === null || code.save.isPending}
              onClick={() =>
                code.save.mutate(value, {
                  onSuccess: () => {
                    setText(null);
                    notify.success({ title: t`Rule code saved` });
                  },
                  onError: (e) =>
                    notify.error({
                      title: t`Could not save the rule code`,
                      message: errorMessage(e, t`Save failed`),
                      forceToast: true,
                    }),
                })
              }
            >
              <Trans>Save code</Trans>
            </Button>
          </>
        )}
      </Advanced>
    </Block>
  );
}

function AgentRulesExplainer({ onBack }: { onBack: () => void }) {
  const discover = useDiscoverRules();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6" data-testid="automation-agent-rules">
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        <Trans>Back</Trans>
      </button>
      <h2 className="text-lg font-semibold">
        <Trans>When an agent does something</Trans>
      </h2>
      <p className="text-sm">
        <Trans>
          These react to what a coding agent is doing — before a tool runs, when a turn ends — and decide in code. Each
          is a folder with a record.json and a trigger.py.
        </Trans>
      </p>
      <p className="text-sm text-muted-foreground">
        <Trans>
          Put the folder under ~/.flow/skill_rules/ (or ask the assistant to write one), then find it here. It shows up
          in the list like any other automation, with its runs.
        </Trans>
      </p>
      <Button
        className="w-fit"
        onClick={() => discover.mutate()}
        disabled={discover.isPending}
        data-testid="automation-discover-rules"
      >
        {discover.isSuccess ? <Trans>Found {discover.data?.length ?? 0} rules</Trans> : <Trans>Find agent rules</Trans>}
      </Button>
    </div>
  );
}
