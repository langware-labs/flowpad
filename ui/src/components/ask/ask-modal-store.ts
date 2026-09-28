import { createOverlayStore } from '@src/store/create-overlay-store';

/**
 * The Ask modal's store. Opened by the `open_ask_modal` ui_command the backend
 * sends when a ComputeOp `ask` is raised and a live tab is listening — see
 * `use-ui-command-listener.ts` and `flow_sdk/core/compute_op/ask_window.py`.
 * The payload is just the question id; the modal fetches everything else
 * itself (`useAskQuestion`), the same way the full-page `win/ask/<id>` route
 * does for the no-live-tab fallback.
 */
const store = createOverlayStore<string>();
export const useAskModalStore = store.useStore;
export const openAskModal = store.open;
export const closeAskModal = store.close;
