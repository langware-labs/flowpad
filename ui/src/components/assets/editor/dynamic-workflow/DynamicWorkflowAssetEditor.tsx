import { t } from '@lingui/core/macro';
import { useState } from 'react';
import { DynamicWorkflow, FSRef, ProcessKind } from '@sdk';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel/EntityExecutionPanel';
import { Button } from '@src/components/ui/button';
import { useFSRefContent } from '@src/hooks/use-fs-ref-content';
import { notify } from '@src/notifications';
import { Boxes, Play, Save, Zap } from 'lucide-react';

interface DynamicWorkflowAssetEditorProps {
  fsRef: FSRef;
  workflow: DynamicWorkflow;
}

/**
 * DynamicWorkflow viewer/editor — an authored dynamic-workflow `.js` script
 * asset (advanced mode only). Edits the script in place (Save → fsRef.write)
 * and offers a Run affordance that launches a Claude worker to execute it
 * (visible PTY or headless background) via the existing worker launcher. The
 * component only reads/writes the file and calls the entity's `run()` action
 * (slick P1 — it never decides routing).
 */
export function DynamicWorkflowAssetEditor({ fsRef, workflow }: DynamicWorkflowAssetEditorProps) {
  // Manual save only — a workflow script must not be written mid-keystroke.
  const { content: script, setContent, dirty, saving, isLoading, save: writeScript } = useFSRefContent(fsRef, {
    autoSave: false,
  });
  const [launching, setLaunching] = useState(false);
  const busy = saving || launching;

  const fileName = fsRef.path.split('/').pop() ?? 'workflow.js';
  const dirPath = fsRef.path.slice(0, -fileName.length - 1);

  const save = async () => {
    try {
      await writeScript();
      notify.success({ title: t`Workflow saved` });
    } catch (err) {
      notify.error({ title: t`Save failed`, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const run = async (ptyMode: boolean) => {
    setLaunching(true);
    try {
      if (dirty) await writeScript();
      await workflow.run(undefined, { ptyMode });
      if (!ptyMode) notify.success({ title: t`Workflow launched`, message: t`Running in the background.` });
    } catch (err) {
      notify.error({ title: t`Failed to launch`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="dynamic-workflow-editor">
      <AssetEditorHeader
        fileName={workflow.name || fileName}
        dirPath={dirPath}
        dirty={dirty}
        actions={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !dirty}
              onClick={() => void save()}
              data-testid="dw-save"
            >
              <Save className="me-1 h-4 w-4" />
              Save
            </Button>
            <Button size="sm" variant="default" disabled={busy} onClick={() => void run(true)} data-testid="dw-run">
              <Play className="me-1 h-4 w-4" />
              Run
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(false)}
              data-testid="dw-run-headless"
            >
              <Zap className="me-1 h-4 w-4" />
              Run headless
            </Button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
        {workflow.description && (
          <p className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Boxes className="h-4 w-4" />
            {workflow.description}
          </p>
        )}
        <textarea
          data-testid="dw-script"
          className="flex-1 resize-none rounded-md border bg-muted/20 p-3 font-mono text-xs leading-relaxed outline-none focus:ring-1 focus:ring-ring"
          spellCheck={false}
          value={script}
          placeholder={isLoading ? 'Loading…' : ''}
          onChange={(e) => {
            setContent(e.target.value);
            workflow.markEdit();
          }}
        />
      </div>

      {/* "Runs of this workflow" — the same EntityExecutionPanel the SubAgent/Skill
          editors mount, keyed by this workflow's typeId. Runs launched via the
          Run buttons are tagged target_typeid_str=Execution, so they appear here. */}
      <div className="h-[280px] flex-shrink-0 border-t" data-testid="dw-runs">
        <EntityExecutionPanel
          target={workflow.typeId.toString()}
          processType={ProcessKind.Execution}
          headerLabel="Workflow runs"
          className="h-full"
        />
      </div>
    </div>
  );
}
