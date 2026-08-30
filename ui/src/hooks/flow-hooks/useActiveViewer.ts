import { ViewType } from '@sdk';
import type { ViewContext } from '@src/types/ViewContext';
import { useEffect } from 'react';
import { useDockNavigation } from '../../navigation/useDockNavigation';
import { useViewerStore } from './useViewerStore';
import { appDockAddress } from '@src/navigation/app-dock';

/**
 * Hook that derives the viewer store's currentContext from the URL dock —
 * the URL is the single source (CLAUDE.md URL-first). The legacy Flow
 * stream-driven focus path retired with the conversational-Flow engine.
 */
export function useActiveViewer() {
  const { setCurrentContext } = useViewerStore();
  const { currentDock, isDockUrl } = useDockNavigation();

  // Sync URL dock state to viewer store (URL-first architecture)
  useEffect(() => {
    // If URL has no dock, clear the viewing context but KEEP the last
    // overview tab — hard-nulling it here (the old `:92` behavior) blanked
    // the overview panel on every dock-less URL. The overview axis resolves
    // from what's already in the store (tab-management.md Part 3 U1).
    if (!isDockUrl || !currentDock) {
      setCurrentContext(null);
      return;
    }

    // Sync dock pointer to currentContext (for editor files, diff, etc.)
    if (currentDock.pointer || currentDock.options) {
      // Typed as the param bag it becomes, not as the string map it starts from:
      // the APP case adds `artifactId`, which is nullable.
      let viewerOptions: NonNullable<ViewContext['viewerOptions']> = currentDock.options ?? {};
      switch (currentDock.viewType) {
        case ViewType.WEB_APP:
          if (currentDock.options?.port) {
            viewerOptions = { ...viewerOptions, port: currentDock.options?.port };
          }
          break;
        case ViewType.APP: {
          // Through the one owner of the app grammar, not a second parse of the
          // pointer here. The viewer derives the RUNTIME itself (MicroApp for
          // `served`, the host process's dev port for `dev`); only identity and the
          // user's preference travel.
          const app = appDockAddress(currentDock);
          if (app) {
            viewerOptions = {
              ...viewerOptions,
              artifactId: app.artifactId,
              ...(app.host ? { host: app.host } : {}),
            };
          }
          break;
        }
        case ViewType.DIFF:
          if (currentDock.pointer) {
            viewerOptions = { ...viewerOptions, checkpointHash: currentDock.pointer };
          }
          break;
        case ViewType.EDITOR:
          break;
        case ViewType.EXPLORER:
          // Explorer uses pointer as path (file or folder)
          // The ExplorerView component will handle resolving file vs folder
          break;
        default:
          break;
      }

      setCurrentContext({
        codeRef: currentDock.pointer ? { path: currentDock.pointer } : undefined,
        viewerType: currentDock.viewType,
        viewerOptions,
      });
    } else {
      // Dock with no pointer or options (like plain tab views) - clear context
      setCurrentContext(null);
    }

    // The header-chip feeding (addTab/setActiveTab) that used to live here is
    // gone — the unified TabStrip replaced the viewer tab header (Part 3 U1);
    // the content panel derives its current tab from the URL directly.
    // Handle other dock types (fs, etc.) here in the future
  }, [currentDock, isDockUrl, setCurrentContext]); // URL drives state, not vice versa.
}
