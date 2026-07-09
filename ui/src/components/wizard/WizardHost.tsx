import {
  AgenticProcess,
  apiClient,
  awaitWizardResult,
  buildWizardPrompt,
  completeWizard,
  ComputeNode,
  ProcessKind,
  setWizardLauncher,
  type WizardLaunchRequest,
  type WizardProcessResult,
} from '@sdk';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { notify } from '@src/notifications/notify';
import { useEffect, useRef, useState } from 'react';
import { Trans } from '@lingui/react/macro';

let wizardAgentRefCache: Record<string, string | null> = {};

async function resolveWizardAgentRef(name: string): Promise<string | null> {
  if (name in wizardAgentRefCache) return wizardAgentRefCache[name];
  const rows = await apiClient.get<{ name?: string; asset_ref?: string }[]>(
    '/graph/agent?include_system=true',
  );
  const ref = (rows ?? []).find((r) => r.name === name)?.asset_ref ?? null;
  wizardAgentRefCache = { ...wizardAgentRefCache, [name]: ref };
  return ref;
}

interface ActiveWizard {
  request: WizardLaunchRequest;
  process: AgenticProcess;
  target: string;
  resolve: (result: WizardProcessResult<unknown>) => void;
}

export function WizardHost() {
  const [active, setActive] = useState<ActiveWizard | null>(null);
  const activeRef = useRef<ActiveWizard | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const restoreLauncher = setWizardLauncher(async <T,>(request: WizardLaunchRequest): Promise<WizardProcessResult<T>> => {
      if (activeRef.current) {
        return { status: 'error', data: null, errorStr: 'Another wizard is already open' };
      }
      try {
        const computeNode = await ComputeNode.getById('@local');
        if (!computeNode) throw new Error('No local compute node');
        const provisionalTarget = `wizard:${request.wizardName}:${Date.now()}`;
        const process = await computeNode.createProcess(
          {
            targetVfsPath: provisionalTarget,
            processType: ProcessKind.Wizard,
            outputFormat: 'stream-json',
            loadFlowpadAssistant: true,
            contextData: {
              wizard: {
                name: request.wizardName,
                data: request.wizardData ?? null,
              },
            },
          },
          { visible: false, pty_mode: false },
        );
        const initialPrompt = buildWizardPrompt(process.id, request);
        const resultPromise = awaitWizardResult<T>(process);
        try {
          const agentRef = await resolveWizardAgentRef(request.wizardName);
          if (agentRef) await process.loadEmbeddedAgent(agentRef);
        } catch (e) {
          console.warn(`[WizardHost] failed to embed wizard agent ${request.wizardName}`, e);
        }

        return await new Promise<WizardProcessResult<T>>((resolve) => {
          const finish = (result: WizardProcessResult<unknown>) => {
            setActive((current) => current?.process.id === process.id ? null : current);
            resolve(result as WizardProcessResult<T>);
          };
          setActive({
            request,
            process,
            target: provisionalTarget,
            resolve: finish,
          });
          void process.prompt(initialPrompt).catch((err) => {
            finish({
              status: 'error',
              data: null,
              errorStr: err instanceof Error ? err.message : String(err),
            });
          });
          resultPromise.then(finish);
        });
      } catch (err) {
        return {
          status: 'error',
          data: null,
          errorStr: err instanceof Error ? err.message : String(err),
        };
      }
    });

    return () => {
      restoreLauncher();
    };
  }, []);

  const closeWith = async (status: 'done' | 'cancel') => {
    if (!active) return;
    try {
      await completeWizard(active.process, { status, data: null, errorStr: null });
    } catch (err) {
      notify.error({ title: 'Wizard close failed', message: err instanceof Error ? err.message : String(err) });
      active.resolve({ status: 'error', data: null, errorStr: err instanceof Error ? err.message : String(err) });
      setActive(null);
    }
  };

  return (
    <Dialog open={!!active} onOpenChange={(open) => { if (!open) void closeWith('cancel'); }}>
      <DialogContent className="flex h-[min(780px,calc(100vh-4rem))] max-w-4xl flex-col p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-sm">
            {active?.request.wizardData?.title || active?.request.wizardName || <Trans>Wizard</Trans>}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {active && (
            <EntityExecutionPanel
              target={active.target}
              processType={ProcessKind.Wizard}
              initialProcessId={active.process.id}
              dense
              emptyStateText="The wizard is starting."
              placeholder="Message the setup wizard..."
            />
          )}
        </div>
        <DialogFooter className="border-t px-4 py-3">
          <Button variant="ghost" onClick={() => void closeWith('cancel')}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void closeWith('done')}>
            <Trans>Done</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
