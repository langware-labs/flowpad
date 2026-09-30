import { useMemo } from 'react';
import { useLocation } from 'react-router';
import { dataManager, TypeId, Wizard } from '@sdk';
import { isFolderShape } from '@sdk/FlowSync/schema';
import { useEntity } from '@sdk/react/hooks';
import { useQuery } from '@tanstack/react-query';

import { recordContentRef } from '@src/components/assets/editor/AssetEditorRouter';

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
  // The chooser takes the screen while it asks; the popup waits and returns when the tab leaves it.
  if (!open || !typeId || pathname.startsWith(LLM_SETUP_PATH)) return null;
  return <WizardPopupHost typeIdStr={typeId} />;
}

function WizardPopupHost({ typeIdStr }: { typeIdStr: string }) {
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
  return <WizardViewer fsRef={fsRef} wizard={wizard} presentation="popup" />;
}
