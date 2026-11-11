import { create } from 'zustand';
import type { ConversationParticipant, HelpOrigin, HelpRecipient, TypeId } from '@sdk';

/** What the Ask for help dialog opens with when another surface hands it a request to finish. */
export interface AskDraft {
  title?: string;
  notes?: string;
  files?: File[];
  person?: ConversationParticipant | null;
  desk?: HelpRecipient | null;
  /** A diagnosis already taken: it goes with the request as it stands, nothing is diagnosed again. */
  diagnosisId?: string | null;
  origin?: HelpOrigin;
  /** Where the person asked from; the screen they are on when none was recorded. */
  projectId?: string | null;
  sessionTypeId?: TypeId | null;
}

interface AskForHelpState {
  draft: AskDraft | null;
  open: (draft: AskDraft) => void;
  close: () => void;
}

/** The dialog every diagnosis surface opens, hosted once by `AskForHelpHost`. */
export const useAskForHelpStore = create<AskForHelpState>((set) => ({
  draft: null,
  open: (draft) => set({ draft }),
  close: () => set({ draft: null }),
}));
