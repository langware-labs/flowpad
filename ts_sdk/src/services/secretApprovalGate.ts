/**
 * Promise-based bridge between non-React code (navigationService) and the
 * globally-mounted SecretApprovalDialog. Listeners are notified only when the
 * dialog should *open*; the dialog manages its own close state and reports the
 * user's decision via ``resolve()``.
 *
 * Flow:
 *   1. Caller invokes ``secretApprovalGate.request()`` → all subscribed
 *      listeners fire (the dialog opens itself); returns a Promise.
 *   2. The dialog handles the user's choice and calls ``resolve(approved)``,
 *      which settles the Promise. The dialog closes itself.
 */

type Resolver = (approved: boolean) => void;
type OpenListener = () => void;

let pending: Resolver | null = null;
const listeners = new Set<OpenListener>();

export const secretApprovalGate = {
  /** Open the approval dialog; resolves with the user's decision. */
  request(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // If a previous request is still open, settle it as cancelled before starting a new one.
      if (pending) {
        const prev = pending;
        pending = null;
        prev(false);
      }
      pending = resolve;
      listeners.forEach((l) => l());
    });
  },

  /** Called by the dialog after the user makes a decision. */
  resolve(approved: boolean): void {
    const r = pending;
    pending = null;
    r?.(approved);
  },

  /** Subscribe to open requests. Returns an unsubscribe function. */
  subscribe(cb: OpenListener): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};
