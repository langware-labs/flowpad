/**
 * A rule on messages arriving — two boxes, a fast test, Save (docs/snippets/stream-inbox-automations.md).
 *
 *   Catch messages on [Work mail] that [ asks for a refund or disputes a charge ]
 *   Then  [Billing helper] should    [ draft the reply … ]
 *
 * The sentence IS the rule's `if` (the backend words it into the gate's question); the prompt
 * and the agent are its `then`. Enabled is a toggle at the top; Save only saves. Under the
 * sentence, a fast test asks the gate about any text; on the right, the try list asks it about
 * recent real messages. Every call goes through the hooks layer → `Trigger.*`.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { messageRuleFields, parseTarget, type DataSource, type ITrigger, type TryRow } from '@sdk';
import { AlertTriangle, ArrowLeft, Check, ExternalLink, Loader2, Play, Save, Trash2, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';
import {
  useAutomation,
  useAutomationCheck,
  useAutomationTrigger,
  useDecideOn,
  useDecideOnRecent,
  useDeleteAutomation,
  useRunOnce,
  useRunnableAgents,
  useSaveAutomation,
  useSetAutomationEnabled,
} from '@src/hooks/automations/useAutomations';
import { sourcesQuery } from '@src/components/data-sources/use-source-specs';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { notify } from '@src/notifications';
import { messageRecipeById } from './automation-recipes';
import { pillClass } from './Pills';
import type { AutomationsRoute } from './automations-pointer';

interface Draft {
  enabled: boolean;
  catch: string;
  /** Data source ids. Empty = any channel. */
  sources: string[];
  /** `agent-<uuid>`. */
  agent: string;
  prompt: string;
}

function draftOf(t: ITrigger): Draft {
  return {
    enabled: t.enabled ?? true,
    catch: t.gate?.sentence ?? '',
    sources: (t.tag_scope ?? []).map((s) => parseTarget(s)[1] ?? s),
    agent: t.then?.run_agent?.agent ?? '',
    prompt: t.then?.run_agent?.prompt ?? '',
  };
}

export function MessageRulePage({ route }: { route: AutomationsRoute }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const triggerId = route.trigger ?? null;
  const isNew = !triggerId;
  // The row is the rule. The list is read once, for the one thing only it knows (whether Flowpad owns the
  // rule) — this page holds no poll of every automation.
  const { automation } = useAutomation(triggerId, { poll: false });
  const triggerQuery = useAutomationTrigger(triggerId);
  const save = useSaveAutomation();
  const remove = useDeleteAutomation();
  const setEnabled = useSetAutomationEnabled();
  const decide = useDecideOn();
  const tries = useDecideOnRecent(triggerId, 20);
  const runOnce = useRunOnce();
  const check = useAutomationCheck();
  const agents = useRunnableAgents();
  const { data: sources = [] } = useEntitiesQuery<DataSource>(sourcesQuery);
  const channels = useMemo(() => sources.filter((s) => !!s.channel), [sources]);

  const loadKey = isNew ? `new:${route.recipe ?? ''}:${route.source ?? ''}` : `id:${triggerId}`;
  const [loaded, setLoaded] = useState<{ key: string; base: Draft; draft: Draft } | null>(null);
  useEffect(() => {
    if (loaded?.key === loadKey) return;
    let base: Draft | null = null;
    if (isNew) {
      const recipe = messageRecipeById(route.recipe);
      base = {
        enabled: true,
        catch: recipe?.catch ?? '',
        sources: route.source ? [route.source] : [],
        agent: '',
        prompt: recipe?.prompt ?? '',
      };
    } else if (triggerQuery.data) base = draftOf(triggerQuery.data as ITrigger);
    if (base) setLoaded({ key: loadKey, base, draft: base });
  }, [loadKey, loaded?.key, isNew, route.recipe, route.source, triggerQuery.data]);

  // Saved rules: Check once, so a missing Decision API is said in one banner.
  useEffect(() => {
    if (triggerId) check.mutate({ triggerId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerId]);

  const [sample, setSample] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const draft = loaded?.draft ?? null;
  const setDraft = (patch: Partial<Draft>) => setLoaded((l) => (l ? { ...l, draft: { ...l.draft, ...patch } } : l));
  const agentName = (agents.data ?? []).find((a) => `agent-${a.id}` === draft?.agent)?.name ?? '';
  // The row shape is the SDK's (`messageRuleFields`): the screen's Save and `Trigger.onMessage` make the same row.
  const fields = draft
    ? messageRuleFields({ ...draft, name: isNew ? null : triggerQuery.data?.name }, agentName)
    : null;
  const dirty = !!loaded && JSON.stringify(loaded.draft) !== JSON.stringify(loaded.base);
  const missing = draft ? [!draft.catch.trim() && 'catch', !draft.agent && 'agent', !draft.prompt.trim() && 'prompt'].filter(Boolean) : [];
  const readOnly = !!automation?.read_only;
  // Check's findings on the `if`: no decider at all is the banner (nothing can be asked); anything else wrong
  // with the sentence is said under it.
  const failing = (check.data?.findings ?? []).filter((f) => !f.ok);
  const noDecisionApi = failing.find((f) => f.area === 'decider')?.message ?? null;
  const ifProblem = failing.find((f) => f.area === 'if')?.message ?? null;

  if (!draft || !fields) {
    return (
      <div className="p-6 text-sm text-muted-foreground" data-testid="message-rule-loading">
        {triggerQuery.error ? errorMessage(triggerQuery.error, t`Could not load this rule`) : <Trans>Loading…</Trans>}
      </div>
    );
  }

  const doSave = async (): Promise<string | null> => {
    if (missing.length) {
      notify.error({
        title: t`Not ready to save`,
        message: [
          missing.includes('catch') && t`Say what to catch.`,
          missing.includes('agent') && t`Pick who handles it.`,
          missing.includes('prompt') && t`Say what they should do.`,
        ]
          .filter(Boolean)
          .join(' '),
        forceToast: true,
      });
      return null;
    }
    try {
      const saved = await save.mutateAsync({ triggerId, fields });
      setLoaded((l) => (l ? { ...l, base: l.draft } : l));
      if (isNew && saved.id) navigation.openDock(DockPointer.forAutomations({ trigger: saved.id }));
      notify.success({ title: isNew ? t`Rule created` : t`Saved`, message: fields.name });
      return saved.id ?? triggerId;
    } catch (e) {
      notify.error({ title: t`Could not save`, message: errorMessage(e, t`Save failed`), forceToast: true });
      return null;
    }
  };

  const onToggle = (on: boolean) => {
    if (isNew) return setDraft({ enabled: on });
    setEnabled.mutate(
      { triggerId, enabled: on },
      {
        onSuccess: () =>
          setLoaded((l) => (l ? { ...l, base: { ...l.base, enabled: on }, draft: { ...l.draft, enabled: on } } : l)),
        onError: (e) => notify.error({ title: t`Could not change it`, message: errorMessage(e, t`It did not work`), forceToast: true }),
      },
    );
  };

  const doFastTest = () => {
    // The sentence as typed is what is tested: the builder's fields when new or edited, the row when saved.
    const about = sample.trim() ? { text: sample.trim() } : { messageId: route.message ?? undefined };
    decide.mutate(triggerId && !dirty ? { triggerId, ...about } : { spec: fields, ...about });
  };

  const doTry = async () => {
    // The try list asks the saved rule: an unsaved or edited one is saved first (which opens its page).
    if (triggerId && !dirty) return void tries.refetch();
    await doSave();
  };

  const verdict = decide.data;
  const caughtWord = (row: TryRow['verdict']) => {
    const sure = Math.round((row.confidence ?? 0) * 100);
    if (row.unavailable) return { kind: 'no', text: t`Couldn’t ask`, sure };
    if (row.met) return { kind: 'yes', text: t`Would catch`, sure };
    return sure >= 50 ? { kind: 'unsure', text: t`Not sure, so no`, sure } : { kind: 'no', text: t`Would not`, sure };
  };

  const toggleSource = (id: string) =>
    setDraft({ sources: draft.sources.includes(id) ? draft.sources.filter((s) => s !== id) : [...draft.sources, id] });

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="message-rule-page" data-automation-id={triggerId ?? 'new'}>
      <header className="flex flex-col gap-2 border-b border-border px-6 pb-3 pt-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigation.openDock(DockPointer.forAutomations())}
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            data-testid="automation-back"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            <Trans>Automations</Trans>
          </button>
          <span className="flex-1" />
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={draft.enabled}
              onCheckedChange={onToggle}
              disabled={readOnly || setEnabled.isPending}
              aria-label={draft.enabled ? t`Turn off` : t`Turn on`}
              data-testid="message-rule-enabled"
            />
            <Trans>Enabled</Trans>
          </label>
          {!isNew && !readOnly && (
            <Button variant="ghost" size="icon" onClick={() => setConfirmDelete(true)} aria-label={t`Delete`} data-testid="automation-delete">
              <Trash2 className="size-4" aria-hidden />
            </Button>
          )}
        </div>
        {noDecisionApi && (
          <div
            className="flex items-center gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
            data-testid="message-rule-no-decision-api"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{noDecisionApi}</span>
            <Button variant="outline" size="sm" className="gap-1" onClick={() => navigation.openTab(ViewType.LLM_SOURCES)}>
              <Trans>LLM sources</Trans>
              <ExternalLink className="size-3.5" aria-hidden />
            </Button>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid gap-5 px-6 py-5 lg:grid-cols-[minmax(0,5fr)_minmax(18rem,4fr)]">
          <div className="flex min-w-0 flex-col gap-6">
            {/* Catch */}
            <section className="flex flex-col gap-2" data-testid="message-rule-catch">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <Trans>Catch</Trans>
                </span>
                <span className="text-muted-foreground">
                  <Trans>messages on</Trans>
                </span>
                <span className="flex flex-wrap gap-1.5" role="group" aria-label={t`Channels`}>
                  <button
                    type="button"
                    aria-pressed={draft.sources.length === 0}
                    onClick={() => setDraft({ sources: [] })}
                    disabled={readOnly}
                    className={pillClass(draft.sources.length === 0)}
                    data-testid="message-rule-source-any"
                  >
                    <Trans>Any channel</Trans>
                  </button>
                  {channels.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={draft.sources.includes(s.id)}
                      onClick={() => toggleSource(s.id)}
                      disabled={readOnly}
                      className={pillClass(draft.sources.includes(s.id))}
                      data-testid={`message-rule-source-${s.id}`}
                    >
                      {s.name || s.channel}
                    </button>
                  ))}
                </span>
                <span className="text-muted-foreground">
                  <Trans>that</Trans>
                </span>
              </div>
              <Textarea
                value={draft.catch}
                onChange={(e) => setDraft({ catch: e.target.value })}
                disabled={readOnly}
                rows={2}
                placeholder={t`ask for a refund or dispute a charge`}
                className="text-sm"
                data-testid="message-rule-catch-text"
              />
              {ifProblem && (
                <p className="rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs" data-testid="message-rule-if-problem">
                  {ifProblem}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                <Trans>
                  Say it the way you’d tell a colleague. Each new message is read and decided on. Your own and your
                  agents’ messages are never caught.
                </Trans>
              </p>
              {/* Fast test */}
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md border border-dashed border-border bg-muted/30 p-2" data-testid="message-rule-fast-test">
                <Textarea
                  value={sample}
                  onChange={(e) => setSample(e.target.value)}
                  rows={2}
                  placeholder={route.message ? t`The message you came from — or paste any message` : t`Paste or type any message`}
                  className="text-sm"
                  data-testid="message-rule-sample"
                />
                <div className="flex flex-col items-end gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1 whitespace-nowrap"
                    onClick={doFastTest}
                    disabled={decide.isPending || (!sample.trim() && !route.message) || !!noDecisionApi}
                    data-testid="message-rule-fast-test-run"
                  >
                    {decide.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                    <Trans>Would it catch this?</Trans>
                  </Button>
                  {verdict && (
                    <VerdictChip {...caughtWord(verdict)} testId="message-rule-fast-test-verdict" />
                  )}
                  {decide.error && <span className="text-xs text-muted-foreground">{errorMessage(decide.error, t`Could not decide`)}</span>}
                </div>
                <span className="col-span-2 text-xs text-muted-foreground">
                  <Trans>One decision, nothing runs.</Trans>
                </span>
              </div>
            </section>

            {/* Then */}
            <section className="flex flex-col gap-2" data-testid="message-rule-then">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <Trans>Then</Trans>
                </span>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                  value={draft.agent}
                  onChange={(e) => setDraft({ agent: e.target.value })}
                  disabled={readOnly}
                  data-testid="message-rule-agent"
                >
                  <option value="">{t`Pick an agent…`}</option>
                  {(agents.data ?? []).map((a) => (
                    <option key={a.id} value={`agent-${a.id}`}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <span className="text-muted-foreground">
                  <Trans>should</Trans>
                </span>
              </div>
              <Textarea
                value={draft.prompt}
                onChange={(e) => setDraft({ prompt: e.target.value })}
                disabled={readOnly}
                rows={3}
                placeholder={t`confirm which charge is in question, explain the refund path, and draft the reply. Don’t send it.`}
                className="text-sm"
                data-testid="message-rule-prompt"
              />
              <p className="text-xs text-muted-foreground">
                <Trans>The agent gets the message and can reply in the conversation. Only agents that can run on this computer are offered.</Trans>
              </p>
            </section>

            <div className="flex items-center gap-3">
              {!readOnly && (
                <Button onClick={() => void doSave()} disabled={save.isPending || (!dirty && !isNew)} className="gap-1.5" data-testid="automation-save">
                  <Save className="size-4" aria-hidden />
                  <Trans>Save</Trans>
                </Button>
              )}
              <span className="flex-1" />
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer underline-offset-2 hover:underline" data-testid="message-rule-json">
                  JSON
                </summary>
                <pre className="mt-2 max-w-xl overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-[11px]">
                  {JSON.stringify(fields, null, 2)}
                </pre>
              </details>
            </div>
          </div>

          {/* Try list */}
          <aside className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4" data-testid="message-rule-try">
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" className="gap-1" onClick={() => void doTry()} disabled={tries.isFetching || !!noDecisionApi} data-testid="message-rule-try-run">
                {tries.isFetching ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                <Trans>Try it on recent messages</Trans>
              </Button>
              <span className="text-xs text-muted-foreground">
                <Trans>Decides, runs nothing</Trans>
              </span>
            </div>
            {tries.data && tries.data.length === 0 && (
              <p className="text-xs text-muted-foreground">
                <Trans>No recent messages on these channels yet.</Trans>
              </p>
            )}
            {tries.data && tries.data.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border bg-background">
                {tries.data.map((row, i) => {
                  const word = caughtWord(row.verdict);
                  const messageId = String(row.state.message_id ?? '');
                  return (
                    <li key={messageId || i} className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5 text-xs" data-testid="message-rule-try-row" data-verdict={word.kind}>
                      <span
                        className={cn(
                          'grid size-4 place-items-center rounded-full text-[10px]',
                          word.kind === 'yes' && 'bg-emerald-500/20 text-emerald-600',
                          word.kind === 'unsure' && 'bg-amber-500/20 text-amber-600',
                          word.kind === 'no' && 'bg-muted text-muted-foreground',
                        )}
                        aria-hidden
                      >
                        {word.kind === 'yes' ? <Check className="size-3" /> : word.kind === 'unsure' ? '?' : '–'}
                      </span>
                      <span className="min-w-0 truncate">
                        <span className="font-medium">{String(row.state.sender ?? '').split('<')[0].trim() || t`Someone`}</span>
                        {row.state.subject ? ` · ${row.state.subject}` : ''}
                        <span className="text-muted-foreground"> — {String(row.state.text ?? '').slice(0, 80)}</span>
                      </span>
                      <span className="flex items-center gap-2 whitespace-nowrap text-muted-foreground">
                        <span title={word.text} className={cn(word.kind === 'yes' && 'text-foreground')}>
                          {word.sure}%{row.decided_at ? ` · ${t`decided`}` : ''}
                        </span>
                        {word.kind === 'yes' && messageId && !row.decided_at && !readOnly && (
                          <button
                            type="button"
                            className="invisible inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] group-hover:visible"
                            onClick={() =>
                              runOnce.mutate(
                                { triggerId: triggerId as string, messageId },
                                { onSuccess: () => notify.success({ title: t`Running it once`, message: t`Follow it on the message.` }) },
                              )
                            }
                            data-testid="message-rule-run-on"
                          >
                            <Play className="size-3" aria-hidden />
                            <Trans>Run on this one</Trans>
                          </button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {tries.error && <p className="text-xs text-muted-foreground">{errorMessage(tries.error, t`Could not try`)}</p>}
            {tries.data && (
              <p className="text-xs text-muted-foreground">
                <Trans>
                  {tries.data.filter((r) => caughtWord(r.verdict).kind === 'yes').length} of {tries.data.length} would be
                  caught. Change the sentence and try again. Hover a caught row to run it for real, once.
                </Trans>
              </p>
            )}
          </aside>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t`Delete this rule?`}
        description={t`Past runs stay in the history.`}
        confirmLabel={t`Delete`}
        variant="destructive"
        onConfirm={() => {
          if (!triggerId) return;
          remove.mutate(triggerId, {
            onSuccess: () => navigation.openDock(DockPointer.forAutomations()),
            onError: (e) => notify.error({ title: t`Could not delete`, message: errorMessage(e, t`It did not work`), forceToast: true }),
          });
        }}
      />
    </div>
  );
}

function VerdictChip({ kind, text, sure, testId }: { kind: string; text: string; sure: number; testId: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        kind === 'yes' && 'border-emerald-500/50 bg-emerald-500/10',
        kind === 'unsure' && 'border-amber-500/50 bg-amber-500/10',
        kind === 'no' && 'border-border text-muted-foreground',
      )}
      data-testid={testId}
      data-verdict={kind}
    >
      {kind === 'yes' && <Zap className="size-3" aria-hidden />}
      {text} · {sure}%
    </span>
  );
}
