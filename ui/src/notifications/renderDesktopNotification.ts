import { DockPointerData, type ViewType } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { notify } from './notify';

/**
 * Layer-1 notification renderer — GENERIC by contract.
 *
 * Draws any `desktop_notify` payload blind: OS banner + attention via the
 * Electron bridge, plus an in-app toast (browser + focused-app fallback).
 * Knows nothing about any specific feature domain — Layer-2 consumers
 * (backend `notify_desktop(...)` callers) flatten their domain into this
 * payload. The OS *badge* is intentionally not handled here: it is state,
 * reflected from `InboxManager.unread` (see `useSyncOsBadge`).
 */

/** Where a click navigates — a dock pointer, never a URL (FE builds the URL). */
export interface NotificationClickTarget {
  view_type: string;
  pointer?: string;
  options?: Record<string, string>;
}

/** The generic payload contract (mirrors backend `websocket.notify_desktop`). */
export interface NotificationPayload {
  /** Tag only ("message" | "process_complete" | …) — never a rendering dispatch. */
  notify_type?: string;
  title?: string;
  body?: string;
  /** Optional toast icon (lucide name); the OS banner always uses the app icon. */
  icon?: string;
  click_target?: NotificationClickTarget;
  /** Default true → dock bounce (macOS) / taskbar flash (Linux/Windows). */
  attention?: boolean;
}

interface NotifyBridge {
  desktopNotify?: (arg: { title: string; body: string; clickTarget?: NotificationClickTarget }) => void;
  notifyAttention?: () => void;
}

/** Resolve where opening a notification navigates — the dock destination for
 *  its click target (shared by the toast link and the banner-click handler). */
export function dockPointerForClickTarget(target?: NotificationClickTarget): DockPointerData | null {
  if (!target?.view_type) return null;
  return new DockPointerData(target.view_type as ViewType, target.pointer, target.options);
}

export function renderDesktopNotification(payload: NotificationPayload): void {
  const title = payload.title || 'Flowpad';
  const body = payload.body || '';

  const bridge = (window as unknown as { electronAPI?: NotifyBridge }).electronAPI;
  if (bridge?.desktopNotify) {
    try {
      bridge.desktopNotify({ title, body, clickTarget: payload.click_target });
      if (payload.attention !== false) bridge.notifyAttention?.();
    } catch {
      // non-fatal — the in-app toast below still fires.
    }
  }

  const pointer = dockPointerForClickTarget(payload.click_target);
  const href = pointer ? new DockPointer(pointer).toUrl(window.location.pathname) : undefined;
  notify({
    level: 'info',
    title,
    message: body,
    icon: payload.icon,
    actions: href ? [{ label: 'Open', href }] : undefined,
  });
}
