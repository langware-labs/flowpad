import { ICompletionOptions } from '@sdk';
import { create } from 'zustand';

interface PendingMessage {
  message: string;
  options: ICompletionOptions;
}

interface SendMessageState {
  // Send message functionality
  sendMessage?: (message: string, options: ICompletionOptions) => Promise<void>;
  setSendMessageHandler: (sendMessage: (message: string, options: ICompletionOptions) => Promise<void>) => void;

  // Set message functionality (pre-fill input without sending)
  setMessage?: (message: string) => void;
  setSetMessageHandler: (setMessage: (message: string) => void) => void;

  // Pending message handling
  pendingMessage: PendingMessage | null;
  setPendingMessage: (pending: PendingMessage | null) => void;
  clearPendingMessage: () => void;
}

export const useSendMessageStore = create<SendMessageState>()((set) => ({
  sendMessage: undefined,
  setSendMessageHandler: (sendMessage) => set({ sendMessage }),
  setMessage: undefined,
  setSetMessageHandler: (setMessage) => set({ setMessage }),
  pendingMessage: null,
  setPendingMessage: (pending) => set({ pendingMessage: pending }),
  clearPendingMessage: () => set({ pendingMessage: null }),
}));
