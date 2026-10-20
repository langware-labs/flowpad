import { useMemo } from 'react';
import { useLocation } from 'react-router';
import { dataManager, TypeId, Wizard } from '@sdk';
import { isFolderShape } from '@sdk/FlowSync/schema';
import { useEntity } from '@sdk/react/hooks';
import { useQuery } from '@tanstack/react-query';

import { recordContentRef } from '@src/components/assets/editor/AssetEditorRouter';

import { useFirstRunFlowStore } from '@src/components/first-run-flow/first-run-flow-store';
import { useLaunchStore } from '@src/components/task-receive/launch-store';
import { useWizardPopupStore } from './wizard-popup-store';
import { WizardViewer } from './WizardViewer';

/** The LLM chooser's own address — a screen that asks its question alone, so nothing is drawn over it. */
const LLM_SETUP_PATH = '/dock/llm-setup';

/**
 * The wizard popup, mounted once at the app root like every other global overlay, so it opens over
 * whatever page is showing and leaves that page exactly as it was.
 */
export function WizardPopupRoot() {
  const open = useWizardPopupStore((s) => s.open);
  const typeId = useWizardPopupStore((s) => s.payload);
  const { pathname } = useLocation();
  // A launch the person asked for is on screen: a popup the app opens by itself (first-run setup
  // on a new install) would cover it — and whatever it has to say — so it waits for the launch.
  const launching = useLaunchStore((s) => s.open);
  // ...unless the first-run flow is up: a launch that arrived before setup is DEFERRED behind it (its dialog waits
  // for the gate), so waiting here would leave each waiting for the other and nothing on screen.
  const flowUp = useFirstRunFlowStore((s) => s.step !== 'idle');
  // The chooser takes the screen while it asks; the popup waits and returns when the tab leaves it. Waiting is
  // SUSPENDED, not unmounted: an unmounted popup forgot that Start was pressed (it came back blank, with no sign
  // that anything was running) and had to load its entity and document again (the page behind showed for a moment).
  if (!open || !typeId) return null;
  return <WizardPopupHost typeIdStr={typeId} suspended={(launching && !flowUp) || pathname.startsWith(LLM_SETUP_PATH)} />;
}

function WizardPopupHost({ typeIdStr, suspended }: { typeIdStr: string; suspended: boolean }) {
  const typeId = useMemo(() => new TypeId(typeIdStr), [typeIdStr]);
  const { data: wizard } = useEntity<Wizard>(typeId, { watch: true });
  // The entity owns its content layout: `record()` carries the path and the filesystem authority.
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
  return <WizardViewer fsRef={fsRef} wizard={wizard} presentation="popup" suspended={suspended} />;
}
