import { editorForPath, ConnectionManager, DockPointerData, dataManager, TypeId, ViewType, type IDockPointer, type UiCommandMessage } from '@sdk';
import { useEffect } from 'react';
import { DockPointer } from '@src/navigation/DockPointer';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import {
  dockPointerForClickTarget,
  renderDesktopNotification,
  type NotificationClickTarget,
  type NotificationPayload,
} from '@src/notifications/renderDesktopNotification';

/** The subset of the Electron preload bridge this hook uses. */
interface NotifyBridge {
  onNotificationClick?: (cb: (data: { clickTarget?: NotificationClickTarget }) => void) => void;
}

/**
 * Listen for server-side `ui_command` WS messages and execute them.
 *
 * Mounted once at the app root (outside the react-router context). We avoid
 * `useNavigate()` here by building the target URL with the same helper
 * react-router uses internally (`buildDockUrl`), then pushing history state
 * and firing `popstate` — which the `createBrowserRouter` listens for.
 *
 * Today we handle `kind === 'navigate_entity'`: fetch the entity (cache,
 * then network if needed), read its `dockPointer`, and rewrite the URL.
 * Unknown `kind` values are ignored — forward-compat so adding new command
 * types on the server doesn't require a matched UI deploy.
 */
export function useUiCommandListener(): void {
  useEffect(() => {
    const cm = ConnectionManager.getInstance();

    // Rewrite the URL to a dock pointer — react-router's createBrowserRouter
    // listens for popstate. Shared by every ui_command handler.
    const navigateTo = (pointer: IDockPointer) => {
      const fullUrl = new DockPointer(pointer).toUrl(window.location.pathname);
      if (fullUrl === window.location.pathname + window.location.search) return;
      window.history.pushState(null, '', fullUrl);
      window.dispatchEvent(new PopStateEvent('popstate'));
    };

    const handleNavigateEntity = async (msg: UiCommandMessage) => {
      if (!msg.type || !msg.id) {
        console.warn('[ui_command] navigate_entity missing type/id', msg);
        return;
      }

      let typeId: TypeId;
      try {
        typeId = new TypeId(msg.type, msg.id);
      } catch (err) {
        console.warn('[ui_command] invalid TypeId', msg, err);
        return;
      }

      // Cache-first; fall back to network. The server already confirmed
      // existence, so the entity is real — we only try to resolve it to
      // get entity-specific `dockPointer` overrides (Shell → SHELL view,
      // AgenticProcess → SHELL view, etc.). If the type has no TS class
      // registered, or the fetch fails, we fall back to the generic
      // HOME + typeId pointer — navigation still works, we just land on
      // the entity's home view instead of its bespoke one.
      let entity = dataManager.getByTypeIdFromCache(typeId);
      if (!entity) {
        try {
          entity = await dataManager.getByTypeId(typeId);
        } catch {
          entity = null;
        }
      }

      const pointer: IDockPointer =
        entity && entity.dockPointer && entity.dockPointer.viewType
          ? entity.dockPointer
          : new DockPointerData(ViewType.HOME, typeId.toString());
      navigateTo(pointer);
    };

    // `navigate_vfs`: open a raw file path in the asset editor — no entity
    // required (the server fell back to this because the path isn't indexed).
    // Editor is chosen by extension; the path is the unique vfs address.
    const handleNavigateVfs = (msg: UiCommandMessage) => {
      if (!msg.path) {
        console.warn('[ui_command] navigate_vfs missing path', msg);
        return;
      }
      const editor = editorForPath(msg.path);
      navigateTo(AssetDocPointer.forVfs(editor, msg.path).toDockPointer());
    };

    const onUiCommand = (msg: UiCommandMessage) => {
      if (msg.kind === 'navigate_entity') {
        void handleNavigateEntity(msg);
        return;
      }
      if (msg.kind === 'navigate_vfs') {
        handleNavigateVfs(msg);
        return;
      }
      if (msg.kind === 'desktop_notify') {
        renderDesktopNotification((msg.info ?? {}) as NotificationPayload);
        return;
      }
      // Forward-compat: log unknown kinds but don't crash.
      console.debug('[ui_command] unhandled kind', msg.kind);
    };

    cm.on('on_ui_command', onUiCommand);

    // Banner click (from main process) → navigate to the payload's generic
    // click target (URL-first, works for any notify_type — the OS badge is
    // handled separately by useSyncOsBadge, driven by InboxManager.unread).
    const bridge = (window as unknown as { electronAPI?: NotifyBridge }).electronAPI;
    bridge?.onNotificationClick?.(({ clickTarget }) => {
      const pointer = dockPointerForClickTarget(clickTarget);
      if (pointer) navigateTo(pointer);
    });

    return () => {
      cm.off('on_ui_command', onUiCommand);
    };
  }, []);
}
