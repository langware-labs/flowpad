import { dataContext } from '@sdk';
import { AskForHelpDialog } from './AskForHelpDialog';
import { useAskForHelpStore } from './ask-for-help-store';

/**
 * Ask for help with a draft: a finished "Check first", or a diagnosis on the feed, the diagnoses
 * table or its viewer. Mounted once in `main.tsx`, beside the Diagnose window it follows.
 */
export function AskForHelpHost() {
  const draft = useAskForHelpStore((s) => s.draft);
  const close = useAskForHelpStore((s) => s.close);
  if (!draft) return null;
  return (
    <AskForHelpDialog
      key={draft.diagnosisId ?? 'draft'}
      open
      onOpenChange={(open) => !open && close()}
      projectId={draft.projectId ?? dataContext.project?.id ?? null}
      sessionTypeId={draft.sessionTypeId ?? null}
      origin={draft.origin ?? 'footer'}
      desk={draft.desk ?? null}
      diagnosisId={draft.diagnosisId ?? null}
      initialTitle={draft.title ?? ''}
      initialNotes={draft.notes ?? ''}
      initialFiles={draft.files}
      initialPerson={draft.person ?? null}
    />
  );
}
