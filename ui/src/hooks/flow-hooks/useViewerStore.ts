import { ViewType } from '@sdk';
import { create } from 'zustand';
import { ViewContext } from '@src/types/ViewContext';
import { VIEWER_REGISTRY } from '@src/types/ViewType';

const TAB_STORAGE_KEY = 'flowpad.tabs';
const VIEW_STACK_MAX_SIZE = 10;

export interface TabItem {
  type: ViewType | 'overview';
  title: string;
  pinned?: boolean;
}

export type TabTypeWithoutOverview = Exclude<TabItem['type'], 'overview'>;

export interface ViewerState {
  // ========== Current View State ==========
  /** Whether user manually overrode the view (takes priority over automation) */
  userOverride: boolean;

  /** Terminal expanded state (affects smart tab switching) */
  isTerminalExpanded: boolean;

  /** Current viewing context */
  currentContext: ViewContext | null;

  // ========== Tab Management State ==========
  /** List of open tabs (excluding Overview which is always present) */
  openTabs: TabItem[];

  /** Currently active tab */
  activeTab: TabItem['type'];

  /** What content to show in the Overview tab (set by agent focus or manual action) */
  currentOverviewTab: ViewType | null;

  /** View navigation stack (max 10 items) for automatic view history */
  viewStack: ViewType[];

  /** Set current viewing context (path, entity, etc.) */
  setCurrentContext: (context: ViewContext | null) => void;

  /** Set terminal expanded state */
  setTerminalExpanded: (expanded: boolean) => void;

  /** Open content with viewer context (optional, for future implementation) */
  open?: (context: Partial<ViewContext>) => void;

  // ========== Tab Management Actions ==========
  /** Add a new tab */
  addTab: (type: TabTypeWithoutOverview, pinned?: boolean, setActive?: boolean) => void;

  /** Remove a tab from view */
  removeTabFromView: (type: TabItem['type']) => void;

  /** Toggle pin state of a tab */
  togglePin: (type: TabItem['type']) => void;

  /** Set active tab */
  setActiveTab: (type: TabItem['type']) => void;

  /** Set overview tab content type */
  setCurrentOverviewTab: (type: ViewType | null) => void;

  /** Reorder tabs (for drag-drop) */
  reorderTabs: (fromIndex: number, toIndex: number) => void;

  // ========== View Stack Actions ==========
  /** Push current view to stack and switch to new view */
  pushViewAndSwitch: (newView: ViewType) => void;

  /** Pop view from stack and return to previous view */
  popViewAndReturn: () => void;
}

// Load initial tabs from localStorage
function loadInitialTabs(): TabItem[] {
  const saved = localStorage.getItem(TAB_STORAGE_KEY);
  if (!saved) return [];
  try {
    const parsed: TabItem[] = JSON.parse(saved);
    return parsed.filter((tab) => tab.pinned); // Only restore pinned tabs
  } catch {
    console.error('Invalid saved tab state in localStorage');
    return [];
  }
}

// Save pinned tabs to localStorage
function savePinnedTabs(tabs: TabItem[]) {
  const pinnedTabs = tabs.filter((tab) => tab.pinned);
  localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(pinnedTabs));
}

export const useViewerStore = create<ViewerState>((set) => ({
  // ========== Initial State ==========
  userOverride: false,
  isTerminalExpanded: false,
  currentContext: null,
  openTabs: loadInitialTabs(),
  activeTab: 'overview',
  currentOverviewTab: ViewType.CHAT,
  viewStack: [],

  setCurrentContext: (context) => set({ currentContext: context }),

  setTerminalExpanded: (expanded) => set({ isTerminalExpanded: expanded }),

  // ========== Tab Management Actions ==========
  addTab: (type, pinned = false, setActive = true) => {
    set((state) => {
      // Don't add if already exists
      if (state.openTabs.find((t) => t.type === type)) {
        if (setActive) {
          return { activeTab: type };
        }
        return {};
      }

      // Get title from registry
      const viewerMeta = VIEWER_REGISTRY[type as ViewType];
      const newTab: TabItem = {
        type,
        title: viewerMeta?.title || type,
        pinned,
      };

      const newOpenTabs = [...state.openTabs, newTab];
      savePinnedTabs(newOpenTabs);

      return {
        openTabs: newOpenTabs,
        ...(setActive && { activeTab: type }),
      };
    });
  },

  removeTabFromView: (type) => {
    set((state) => {
      const newOpenTabs = state.openTabs.filter((tab) => tab.type !== type);
      savePinnedTabs(newOpenTabs);

      // If closing active tab, switch to overview or first available tab
      const newActiveTab =
        state.activeTab === type ? (newOpenTabs.length > 0 ? newOpenTabs[0].type : 'overview') : state.activeTab;

      return {
        openTabs: newOpenTabs,
        activeTab: newActiveTab,
      };
    });
  },

  togglePin: (type) => {
    set((state) => {
      const tabIndex = state.openTabs.findIndex((t) => t.type === type);
      if (tabIndex === -1) return {};

      const updatedTab = { ...state.openTabs[tabIndex], pinned: !state.openTabs[tabIndex].pinned };
      const newOpenTabs = [...state.openTabs];
      newOpenTabs[tabIndex] = updatedTab;

      // Reorder: pinned tabs first, then unpinned
      const pinned = newOpenTabs.filter((t) => t.pinned);
      const unpinned = newOpenTabs.filter((t) => !t.pinned);
      const orderedTabs = [...pinned, ...unpinned];

      savePinnedTabs(orderedTabs);

      return { openTabs: orderedTabs };
    });
  },

  setActiveTab: (type) => {
    set({ activeTab: type });
  },

  setCurrentOverviewTab: (type) => {
    set({ currentOverviewTab: type });
  },

  reorderTabs: (fromIndex, toIndex) => {
    set((state) => {
      const newOpenTabs = [...state.openTabs];
      const [movedTab] = newOpenTabs.splice(fromIndex, 1);
      newOpenTabs.splice(toIndex, 0, movedTab);
      savePinnedTabs(newOpenTabs);
      return { openTabs: newOpenTabs };
    });
  },

  // ========== View Stack Actions ==========
  pushViewAndSwitch: (newView) => {
    set((state) => {
      const currentView = state.currentOverviewTab;
      if (!currentView) return { currentOverviewTab: newView };

      const newStack = [...state.viewStack];

      // Don't push duplicate consecutive views
      if (newStack[newStack.length - 1] !== currentView) {
        newStack.push(currentView);
      }

      // Limit to max size
      if (newStack.length > VIEW_STACK_MAX_SIZE) {
        newStack.shift();
      }

      return {
        viewStack: newStack,
        currentOverviewTab: newView,
      };
    });
  },

  popViewAndReturn: () => {
    set((state) => {
      if (state.viewStack.length === 0) {
        // Default to chat when stack empty
        return { currentOverviewTab: ViewType.CHAT };
      }

      const newStack = [...state.viewStack];
      const previousView = newStack.pop();

      return {
        viewStack: newStack,
        currentOverviewTab: previousView || ViewType.CHAT,
      };
    });
  },
}));
