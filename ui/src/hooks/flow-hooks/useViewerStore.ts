import { ViewType } from '@sdk';
import { create } from 'zustand';
import { ViewContext } from '@src/types/ViewContext';

const VIEW_STACK_MAX_SIZE = 10;

/**
 * Viewer store — overview-axis mechanics only.
 *
 * The header tab membership this store used to own (`openTabs`, pinned-tab
 * localStorage, `addTab` / `removeTabFromView` / `togglePin` / `setActiveTab`
 * / `reorderTabs`, `activeTab`) was retired with the unified TabStrip
 * (docs/tab-management.md Part 3 U1): tab membership is entity-backed
 * (`tabbed`, src/tabs/useTabs.ts) and the active tab derives from the URL.
 * What remains here is the overview panel's own axis: which content the
 * overview slot shows (`currentOverviewTab` + `viewStack`), the current
 * viewing context, and the terminal-expanded flag.
 */
export interface ViewerState {
  // ========== Current View State ==========
  /** Whether user manually overrode the view (takes priority over automation) */
  userOverride: boolean;

  /** Terminal expanded state (affects smart tab switching) */
  isTerminalExpanded: boolean;

  /** Current viewing context */
  currentContext: ViewContext | null;

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

  /** Set overview tab content type */
  setCurrentOverviewTab: (type: ViewType | null) => void;

  // ========== View Stack Actions ==========
  /** Push current view to stack and switch to new view */
  pushViewAndSwitch: (newView: ViewType) => void;

  /** Pop view from stack and return to previous view */
  popViewAndReturn: () => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
  // ========== Initial State ==========
  userOverride: false,
  isTerminalExpanded: false,
  currentContext: null,
  currentOverviewTab: ViewType.CHAT,
  viewStack: [],

  setCurrentContext: (context) => set({ currentContext: context }),

  setTerminalExpanded: (expanded) => set({ isTerminalExpanded: expanded }),

  setCurrentOverviewTab: (type) => {
    set({ currentOverviewTab: type });
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
