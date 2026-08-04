import { useCallback, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { AgenticProcess, GraphContext, ProcessKind, TypeId, isTypeId, type AssetDescriptor } from '@sdk';
import { AssetManagerPopover, RUNNABLE_ASSETS } from '@src/components/asset-manager/AssetManagerPopover';
import { displayLabelForTypeid, parseTypeid } from '@src/components/asset-manager/asset-row-helpers';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { SideDrawer } from '@src/components/ui/side-drawer';
import { CollapsedSideRail } from '@src/components/ui/collapsed-side-rail';
import { RunButton } from '@src/components/assets/editor/run/RunButton';
import { notify } from '@src/notifications';
import { Play } from 'lucide-react';

/**
 * "Run Automation" surface for a GraphContext: pick an agent or a skill, launch
 * an agentic process keyed to the context (its `target_typeid_str`), and stream
 * it in the standard `EntityExecutionPanel` side window. The picked automation
 * is attached (agent → `loadEmbeddedAgent`, skill → `embeddedAssets.attach`) and
 * the context's members are stamped as the process's shared context so the run
 * executes *on* the context.
 */
export function RunAutomationPanel({ ctx }: { ctx: GraphContext }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [runNonce, setRunNonce] = useState(0);
  const [instruction, setInstruction] = useState('');
  // Latest picked descriptor — read inside onProcessCreated (which fires after a
  // re-render, so a ref avoids threading it through the autoPrompt payload).
  const pendingRef = useRef<AssetDescriptor | null>(null);

  const handlePick = useCallback((d: AssetDescriptor) => {
    pendingRef.current = d;
    const { type } = parseTypeid(d.typeid);
    const name = displayLabelForTypeid(d.typeid);
    setInstruction(
      type === 'subagent'
        ? t`Act as the "${name}" agent and work on the current context.`
        : t`Run the skill "${name}" on the current context.`,
    );
    setOpen(true);
    setRunNonce((n) => n + 1);
  }, []);

  // Runs once per launched process, before its first prompt: attach the picked
  // automation and bind the context's members as the process's shared context.
  const runOnContext = useCallback(
    async (proc: AgenticProcess) => {
      const d = pendingRef.current;
      if (!d) return;
      try {
        const { type } = parseTypeid(d.typeid);
        if (type === 'subagent' && d.posix_path) {
          await proc.loadEmbeddedAgent(d.posix_path);
        } else {
          await proc.embeddedAssets.attach(d.typeid);
        }
        const members = (ctx.context_typeids ?? []).filter((t) => isTypeId(t)).map((t) => new TypeId(t));
        if (members.length > 0) await proc.shareContextEntities(members);
      } catch (err) {
        console.error('[RunAutomationPanel] run setup failed', err);
        notify.error({
          title: t`Could not start automation`,
          message: err instanceof Error ? err.message : t`Run setup failed.`,
        });
      }
    },
    [ctx.context_typeids],
  );

  // The rail and the drawer header host the same picker; only the trigger
  // differs. Sharing one prop bundle is what keeps them from drifting.
  const pickerProps = {
    filter: RUNNABLE_ASSETS,
    searchPlaceholder: t`Search agents and skills…`,
    onPick: handlePick,
  };

  // Collapsed: a thin rail whose Play button opens the agent/skill picker.
  if (!open) {
    return (
      <CollapsedSideRail data-testid="run-automation-rail">
        <AssetManagerPopover
          trigger={
            <button
              type="button"
              title={t`Run automation`}
              aria-label={t`Run automation`}
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              data-testid="run-automation-rail-button"
            >
              <Play className="h-4 w-4" />
            </button>
          }
          {...pickerProps}
        />
      </CollapsedSideRail>
    );
  }

  // Expanded: the standard side drawer hosting the standard execution panel.
  return (
    <SideDrawer
      open
      onOpenChange={setOpen}
      width="w-96"
      data-testid="run-automation-drawer"
      headerActions={<AssetManagerPopover trigger={<RunButton idleLabel={t`Run automation`} />} {...pickerProps} />}
    >
      <EntityExecutionPanel
        target={ctx.typeId.toString()}
        processType={ProcessKind.Execution}
        headerLabel="Automation"
        onProcessCreated={runOnContext}
        autoPrompt={runNonce > 0 ? { text: instruction, nonce: runNonce, newSession: true } : null}
        className="h-full min-h-0"
      />
    </SideDrawer>
  );
}
