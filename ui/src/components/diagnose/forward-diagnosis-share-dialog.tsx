import { useMemo } from 'react';
import { FlowpadDiagnosis, TypeId } from '@sdk';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { genericEntityShareSource } from '@src/hooks/share-sources';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

interface ForwardDiagnosisShareDialogProps {
  open: boolean;
  onClose: () => void;
  /** The FlowpadDiagnosis entity id (UUID, no type prefix). */
  diagnosisId: string;
  /** Display title used for the source chip and the message caption. */
  diagnosisTitle?: string;
  /** Fired after the diagnosis has been forwarded into the (new or existing)
   *  conversation — lets the caller dismiss its own surface. Navigation to the
   *  conversation is handled here. */
  onForwarded?: (conversationId: string) => void;
}

/**
 * "Start new conversation" for a diagnosis forward: the shared
 * `ShareToConversationDialog`, stripped to just the recipient picker and the
 * conversation list (Title + Note hidden — the diagnosis chip and the
 * `Diagnosis: <title>` caption carry the meaning). Picking a contact lets the
 * user forward the diagnosis into a brand-new conversation that includes that
 * contact, instead of only their own existing conversations.
 */
export function ForwardDiagnosisShareDialog({
  open,
  onClose,
  diagnosisId,
  diagnosisTitle,
  onForwarded,
}: ForwardDiagnosisShareDialogProps) {
  const { navigation } = useDockNavigation();
  const label = diagnosisTitle ? `Diagnosis: ${diagnosisTitle}` : 'Diagnosis';
  const source = useMemo(
    () =>
      genericEntityShareSource(new TypeId(FlowpadDiagnosis.type, diagnosisId), {
        label,
        typeLabel: 'DIAGNOSIS',
      }),
    [diagnosisId, label],
  );

  return (
    <ShareToConversationDialog
      open={open}
      onClose={onClose}
      source={source}
      defaultNote={label}
      hideTitle
      hideNote
      onShared={(conversationId) => {
        navigation.openDock(DockPointer.forConversation(conversationId));
        onForwarded?.(conversationId);
        onClose();
      }}
    />
  );
}
