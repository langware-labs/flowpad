import { create } from 'zustand';

export interface TabInfo {
  path: string;
  isDirty?: boolean;
  isPinned?: boolean;
  /** Preview tab: the next opened file replaces it (single-click browsing).
   *  Editing it or double-clicking it keeps it open. */
  isPreview?: boolean;
  onDirtyChange: (isDirty: boolean) => void;
}

/** Open `tab` the way a code editor does: it takes the preview slot in place,
 *  or is appended when there is none. Editing, double-clicking or pinning a tab
 *  clears its `isPreview`, so kept tabs are never closed by opening. */
export function openInPreview(prev: TabInfo[], tab: TabInfo): TabInfo[] {
  if (prev.some((t) => t.path === tab.path)) return prev;
  const slot = prev.findIndex((t) => t.isPreview);
  if (slot < 0) return [...prev, tab];
  const next = [...prev];
  next[slot] = tab;
  return next;
}

interface EditorState {
  editorTabs: TabInfo[];
  editorActiveTab: string;
  isTerminalExpanded: boolean;
  showFileTree: boolean;
  setEditorTabs: (content: TabInfo[]) => void;
  setEditorActiveTab: (path: string) => void;
  setIsTerminalExpanded: (isTerminalExpanded: boolean) => void;
  setShowFileTree: (showFileTree: boolean) => void;
  clearEditorContent: () => void;
}

export const useEditorStore = create<EditorState>()((set) => ({
  editorTabs: [],
  editorActiveTab: '',
  isTerminalExpanded: false,
  showFileTree: true,

  setEditorTabs: (editorTabs) => set({ editorTabs }),
  setEditorActiveTab: (path) => set({ editorActiveTab: path }),
  setIsTerminalExpanded: (isTerminalExpanded) => set({ isTerminalExpanded }),
  setShowFileTree: (showFileTree) => set({ showFileTree }),

  clearEditorContent: () =>
    set({
      editorTabs: [],
      editorActiveTab: '',
      isTerminalExpanded: false,
    }),
}));
