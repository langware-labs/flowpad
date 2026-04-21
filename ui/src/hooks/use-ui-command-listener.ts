import { ConnectionManager, dataManager, TypeId, type UiCommandMessage } from '@sdk';
import { useEffect } from 'react';
import { buildDockUrl, stripDockPortion } from '@src/navigation/url-builder';

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
      // existence, so a cache miss just means we fetch it now.
      let entity = dataManager.getByTypeIdFromCache(typeId);
      if (!entity) {
        try {
          entity = await dataManager.getByTypeId(typeId);
        } catch (err) {
          console.warn('[ui_command] getByTypeId failed', typeId.toString(), err);
          return;
        }
      }
      if (!entity) {
        console.warn('[ui_command] entity not retrievable', typeId.toString());
        return;
      }

      const pointer = entity.dockPointer;
      if (!pointer || !pointer.viewType) {
        console.warn('[ui_command] entity has no dockPointer', typeId.toString());
        return;
      }

      // Build the dock URL relative to the current path. This preserves
      // agent/process base segments (e.g. /agent/<id>/flow/<id>/dock/...).
      const currentPath = window.location.pathname;
      const pointerStr = pointer.pointer ?? undefined;
      const options = (pointer.options ?? undefined) as Record<string, string> | undefined;
      const fullUrl = buildDockUrl(currentPath, pointer.viewType, pointerStr, options, pointer.layout);

      if (fullUrl === window.location.pathname + window.location.search) return;

      // createBrowserRouter listens for popstate — this is how we navigate
      // without needing a react-router hook.
      const basePath = stripDockPortion(currentPath);
      const navUrl = basePath && fullUrl.startsWith(basePath) ? fullUrl : fullUrl;
      window.history.pushState(null, '', navUrl);
      window.dispatchEvent(new PopStateEvent('popstate'));
    };

    const onUiCommand = (msg: UiCommandMessage) => {
      if (msg.kind === 'navigate_entity') {
        void handleNavigateEntity(msg);
        return;
      }
      // Forward-compat: log unknown kinds but don't crash.
      console.debug('[ui_command] unhandled kind', msg.kind);
    };

    cm.on('on_ui_command', onUiCommand);
    return () => {
      cm.off('on_ui_command', onUiCommand);
    };
  }, []);
}
