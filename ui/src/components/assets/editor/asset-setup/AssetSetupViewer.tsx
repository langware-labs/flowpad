import { useMemo } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { dataManager, SETUP_HOOKS, TypeId, Wizard, type AssetSetup, type FSRef } from '@sdk';
import { isFolderShape } from '@sdk/FlowSync/schema';
import { useEntity } from '@sdk/react/hooks';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Play, Square } from 'lucide-react';

import { AskForm } from '@src/components/ask/AskForm';
import { recordContentRef } from '@src/components/assets/editor/AssetEditorRouter';
import { WizardViewer } from '@src/components/assets/editor/wizard/WizardViewer';
import { SetupTreeView } from '@src/components/project-setup/SetupTreeView';
import { useSetupRun } from '@src/components/project-setup/use-setup-run';
import { Button } from '@src/components/ui/button';
import { useJsonDoc } from '@src/hooks/use-json-doc';

const MAIN_FILE = 'asset_setup.json';

interface AssetSetupDoc {
  name?: string;
  label?: string;
  subject?: string;
  prepare?: string;
  run?: string;
  on_load?: string;
  inputs?: Record<string, string>;
}

/**
 * A declared setup node, shown with the screens setup already has: its steps and their live state
 * (the tree the "Setup required" dialog draws, rooted at this node) and the wizard each of its
 * three hooks fires, in the wizard's own view. Nothing here edits the document.
 */
export function AssetSetupViewer({ setup, fsRef }: { setup: AssetSetup; fsRef: FSRef }) {
  const { t } = useLingui();
  const { doc } = useJsonDoc<AssetSetupDoc>(useMemo(() => fsRef.child(MAIN_FILE), [fsRef]));
  const name = doc?.name ?? setup.name;
  const projectId = setup.project_id ?? '';
  const run = useSetupRun(projectId, name ? `asset_setup:${name}` : '', undefined, { autoStart: false });
  const busy = run.running || run.starting;

  const { data: hooks } = useQuery({
    queryKey: ['asset-setup-hooks', setup.typeId.toString()],
    queryFn: () => setup.hooks(),
  });

  const hookLabel: Record<(typeof SETUP_HOOKS)[number], string> = {
    prepare: t`Prepare — before its steps`,
    run: t`Run — once its steps are set up`,
    on_load: t`On load — each time it is shown`,
  };
  const inputs = Object.entries(doc?.inputs ?? {});

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="asset-setup-viewer">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="truncate text-sm font-medium">{doc?.label || name}</span>
        {doc?.subject && <code className="truncate font-mono text-xs text-muted-foreground">{doc.subject}</code>}
        <span className="flex-1" />
        {projectId &&
          (busy ? (
            run.stop && (
              <Button size="sm" variant="outline" onClick={() => void run.stop?.()} data-testid="asset-setup-stop">
                <Square className="mr-1 size-3.5" />
                <Trans>Stop</Trans>
              </Button>
            )
          ) : (
            <Button size="sm" onClick={() => void run.start()} data-testid="asset-setup-start">
              <Play className="mr-1 size-3.5" />
              <Trans>Run setup</Trans>
            </Button>
          ))}
      </header>

      <div className="flex flex-col gap-5 px-4 py-3 text-sm">
        <section data-testid="asset-setup-steps">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Trans>Steps</Trans>
          </h3>
          {!projectId ? (
            <p className="text-muted-foreground">
              <Trans>This setup belongs to no project here, so it has no run to show.</Trans>
            </p>
          ) : (
            <>
              {busy &&
                (run.questionId ? (
                  <AskForm questionId={run.questionId} showOp={false} onSettled={run.settleQuestion} />
                ) : (
                  <p className="mb-2 flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    <Trans>Working…</Trans>
                  </p>
                ))}
              {run.tree ? (
                <SetupTreeView tree={run.tree} />
              ) : (
                <p className="text-muted-foreground">
                  <Trans>Not run yet.</Trans>
                </p>
              )}
            </>
          )}
        </section>

        {SETUP_HOOKS.map((hook) => (
          <section key={hook} data-testid={`asset-setup-hook-${hook}`}>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {hookLabel[hook]}
            </h3>
            {!doc?.[hook] ? (
              <p className="text-muted-foreground">
                <Trans>None.</Trans>
              </p>
            ) : hooks?.[hook] ? (
              <div className="overflow-hidden rounded-md border">
                <HookWizard typeIdStr={hooks[hook]} />
              </div>
            ) : (
              <p className="text-muted-foreground">
                <code className="font-mono text-xs">{doc[hook]}</code>
                {hooks && (
                  <>
                    {' — '}
                    <Trans>no wizard by this name was found.</Trans>
                  </>
                )}
              </p>
            )}
          </section>
        ))}

        {inputs.length > 0 && (
          <section data-testid="asset-setup-inputs">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Trans>Inputs</Trans>
            </h3>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              {inputs.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="font-mono text-xs text-muted-foreground">{key}</dt>
                  <dd className="break-all font-mono text-xs">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </div>
  );
}

/** One hook's wizard, in the wizard's own page view — the same lookup the wizard popup does. */
function HookWizard({ typeIdStr }: { typeIdStr: string }) {
  const typeId = useMemo(() => new TypeId(typeIdStr), [typeIdStr]);
  const { data: wizard } = useEntity<Wizard>(typeId, { watch: true });
  const { data: record } = useQuery({
    queryKey: ['asset-record-refs', 'local', typeIdStr],
    queryFn: () => wizard!.record({ hubReflect: false }),
    enabled: !!wizard,
  });
  const fsRef = useMemo(
    () =>
      record?.mainRef
        ? recordContentRef(record.mainRef, isFolderShape(dataManager.getTypeInfo(Wizard.type)?.shape))
        : null,
    [record],
  );
  if (!wizard || !fsRef) return null;
  return <WizardViewer fsRef={fsRef} wizard={wizard} />;
}
