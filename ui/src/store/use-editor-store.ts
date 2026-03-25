import { create } from 'zustand';

export interface TabInfo {
  path: string;
  isDirty?: boolean;
  isPinned?: boolean;
  onDirtyChange: (isDirty: boolean) => void;
}

interface EditorState {
  editorTabs: TabInfo[];
  editorActiveTab: string;
  isTerminalExpanded: boolean;
  setEditorTabs: (content: TabInfo[]) => void;
  setEditorActiveTab: (path: string) => void;
  setIsTerminalExpanded: (isTerminalExpanded: boolean) => void;
  clearEditorContent: () => void;
}

export const useEditorStore = create<EditorState>()((set) => ({
  editorTabs: [],
  editorActiveTab: '',
  isTerminalExpanded: false,

  setEditorTabs: (editorTabs) => set({ editorTabs }),
  setEditorActiveTab: (path) => set({ editorActiveTab: path }),
  setIsTerminalExpanded: (isTerminalExpanded) => set({ isTerminalExpanded }),

  clearEditorContent: () =>
    set({
      editorTabs: [],
      editorActiveTab: '',
      isTerminalExpanded: false,
    }),
}));
