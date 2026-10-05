/**
 * My automations — the simple-first view.
 *
 * One sentence per automation, its last result and what happens next, grouped
 * by whose it is: this project, mine everywhere, other projects, and — folded
 * into one line — Flowpad's own. Kinds are filter chips with counts, not
 * sections; an attention strip names failures before anyone has to look.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { AutomationKind, AutomationSummary } from '@sdk';
import { AlertTriangle, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { useContext } from '@src/hooks/useContext';
import { useAutomations, useRunOnce, useSetAutomationEnabled } from '@src/hooks/automations/useAutomations';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { useAutomationWords } from './automation-words';
import { AutomationRow } from './AutomationRow';
import { KindGallery } from './KindGallery';
import { IfThenGraphic } from './IfThenGraphic';
import { Pills } from './Pills';

const KIND_ORDER: AutomationKind[] = ['schedule', 'event', 'file', 'agent_hook'];

export function AutomationsList() {
  const { t } = useLingui();
  const words = useAutomationWords();
  const { navigation } = useDockNavigation();
  const projectId = useContext().project?.id ?? null;
  const { data: automations = [], isLoading, error } = useAutomations();
  const runOnce = useRunOnce();
  const setEnabled = useSetAutomationEnabled();
  const [kind, setKind] = useState<AutomationKind | null>(null);
  const [showBuiltin, setShowBuiltin] = useState(false);
  const [choosing, setChoosing] = useState(false);

  const counts = useMemo(() => {
    const c: Partial<Record<AutomationKind, number>> = {};
    for (const a of automations) if (a.group !== 'builtin') c[a.kind] = (c[a.kind] ?? 0) + 1;
    return c;
  }, [automations]);

  const visible = automations.filter((a) => !kind || a.kind === kind);
  const groups = {
    project: visible.filter((a) => a.group === 'project' && a.project_id === projectId),
    mine: visible.filter((a) => a.group === 'mine'),
    otherProjects: visible.filter((a) => a.group === 'project' && a.project_id !== projectId),
    builtin: visible.filter((a) => a.group === 'builtin'),
  };
  const yours = automations.filter((a) => a.group !== 'builtin');
  const failing = yours.filter((a) => a.last_run?.status === 'failed');
  const builtinFailing = groups.builtin.filter((a) => a.last_run?.status === 'failed');

  const open = (a: AutomationSummary) => navigation.openDock(DockPointer.forAutomations({ trigger: a.id }));
  const create = (k: AutomationKind, recipe?: string) =>
    navigation.openDock(DockPointer.forAutomations({ creating: k, recipe: recipe ?? null }));

  const onRunOnce = (a: AutomationSummary) =>
    runOnce.mutate(
      { triggerId: a.id },
      {
        onSuccess: () => notify.success({ title: t`Running ${a.name}`, message: t`It shows up in Runs as a test.` }),
        onError: (e) =>
          notify.error({
            title: t`Could not run ${a.name}`,
            message: errorMessage(e, t`Run failed`),
            forceToast: true,
          }),
      },
    );
  const onToggle = (a: AutomationSummary, enabled: boolean) =>
    setEnabled.mutate(
      { triggerId: a.id, enabled },
      {
        onError: (e) =>
          notify.error({
            title: t`Could not change ${a.name}`,
            message: errorMessage(e, t`Update failed`),
            forceToast: true,
          }),
      },
    );

  const rows = (list: AutomationSummary[]) =>
    list.map((a) => (
      <AutomationRow
        key={a.id}
        automation={a}
        onOpen={() => open(a)}
        onToggle={(on) => onToggle(a, on)}
        onRunOnce={() => onRunOnce(a)}
        busy={
          (runOnce.isPending && runOnce.variables?.triggerId === a.id) ||
          (setEnabled.isPending && setEnabled.variables?.triggerId === a.id)
        }
      />
    ));

  const group = (key: string, title: string, list: AutomationSummary[]) =>
    list.length ? (
      <section key={key} data-testid={`automations-group-${key}`}>
        <h3 className="px-4 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {rows(list)}
      </section>
    ) : null;

  const empty = !isLoading && yours.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="automations-list">
      <header className="flex flex-wrap items-center justify-between gap-3 px-6 pb-3 pt-6">
        {!empty && <IfThenGraphic />}
        {!empty && (
          <Button className="gap-1.5" onClick={() => setChoosing((c) => !c)} data-testid="automation-new">
            <Plus className="size-4" aria-hidden />
            <Trans>New automation</Trans>
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-8">
        {choosing && !empty && (
          <div className="mb-4 rounded-lg border border-border p-4">
            <KindGallery compact onPick={(k, r) => create(k, r)} />
          </div>
        )}

        {failing.length > 0 && (
          <button
            type="button"
            data-testid="automations-attention"
            onClick={() => navigation.openDock(DockPointer.forAutomations({ place: 'runs', status: 'failed' }))}
            className="mb-4 flex w-full items-center gap-2 rounded-md border border-red-500/60 bg-red-500/10 px-3 py-2 text-left text-sm text-foreground hover:bg-red-500/15"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              {failing.length === 1 ? (
                <Trans>{failing[0].name} failed last time it ran.</Trans>
              ) : (
                <Trans>{failing.length} automations failed last time they ran.</Trans>
              )}
            </span>
            <span className="shrink-0 font-medium underline-offset-2 hover:underline">
              <Trans>See what went wrong</Trans>
            </span>
          </button>
        )}

        {error ? (
          <div className="rounded-md border border-red-500/60 bg-red-500/10 px-3 py-2 text-sm">
            {errorMessage(error, t`Could not load automations`)}
          </div>
        ) : empty ? (
          <div className="mx-auto max-w-3xl">
            <IfThenGraphic />
            <KindGallery onPick={(k, r) => create(k, r)} />
          </div>
        ) : (
          <>
            <div className="pb-2">
              <Pills
                testId="automations-chip"
                label={t`Filter by kind`}
                value={kind ?? 'all'}
                onChange={(v) => setKind(v === 'all' || v === kind ? null : (v as AutomationKind))}
                options={[
                  {
                    value: 'all',
                    label: (
                      <>
                        {t`All`} <span className="text-muted-foreground">{yours.length}</span>
                      </>
                    ),
                  },
                  ...KIND_ORDER.filter((k) => counts[k]).map((k) => ({
                    value: k,
                    label: (
                      <>
                        {words.kindPlural(k)} <span className="text-muted-foreground">{counts[k]}</span>
                      </>
                    ),
                  })),
                ]}
              />
            </div>
            <div className="overflow-hidden rounded-lg border border-border [&>section:first-child>h3]:pt-3">
              {group('project', t`This project`, groups.project)}
              {group('mine', t`Mine, everywhere`, groups.mine)}
              {group('other', t`Other projects`, groups.otherProjects)}
              {groups.builtin.length > 0 && (
                <section data-testid="automations-group-builtin" className="border-t border-border">
                  <button
                    type="button"
                    onClick={() => setShowBuiltin((s) => !s)}
                    data-testid="automations-builtin-toggle"
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-muted-foreground hover:bg-accent/40"
                    aria-expanded={showBuiltin}
                  >
                    {showBuiltin ? (
                      <ChevronDown className="size-3.5" aria-hidden />
                    ) : (
                      <ChevronRight className="size-3.5" aria-hidden />
                    )}
                    <span className="font-medium text-foreground">
                      <Trans>Built into Flowpad</Trans>
                    </span>
                    <span>{groups.builtin.length}</span>
                    <span
                      className={cn(
                        'ml-auto',
                        builtinFailing.length &&
                          'rounded border border-red-500/60 bg-red-500/10 px-1.5 text-foreground',
                      )}
                    >
                      {builtinFailing.length ? (
                        <Trans>{builtinFailing[0].name} failed</Trans>
                      ) : (
                        <Trans>All healthy</Trans>
                      )}
                    </span>
                  </button>
                  {showBuiltin && rows(groups.builtin)}
                </section>
              )}
            </div>
            {visible.length === 0 && (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                <Trans>Nothing of this kind yet.</Trans>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
