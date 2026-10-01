import { t } from '@lingui/core/macro';
import { DockPointerData, type ViewType } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { notify } from './notify';
import { APP_NAME } from '@src/constants/app';

/**
 * Layer-1 notification renderer — GENERIC by contract.
 *
 * Draws any `desktop_notify` payload blind: OS banner + attention via the
 * Electron bridge, plus an in-app toast (browser + focused-app fallback).
 * Knows nothing about any specific feature domain — Layer-2 consumers
 * (backend `notify_desktop(...)` callers) flatten their domain into this
 * payload. The OS *badge* is intentionally not handled here: it is state,
 * reflected from `StreamInboxManager.unread` (see `useSyncOsBadge`).
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
  /** Omitted → `info`. `warning` / `error` say something did NOT happen: kept in the footer
   *  warnings list as well as shown. */
  level?: 'info' | 'warning' | 'error';
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

/** The line the backend writes when someone shares a project with you
 *  (`Project._invite_message_text`), then the sharer's own note after a blank line, if any. */
const INVITE_TEXT = /^I invited you to project "(.+?)"\.(?:\n\n([\s\S]*))?$/;

/** A notification body in the person's language. The invite line is a fixed sentence the SENDER's
 *  backend wrote in English, so it is matched here and rebuilt; the sharer's note is theirs and is
 *  never touched. Any other body is shown as it came. */
export function localizedBody(body: string): string {
  const m = body.match(INVITE_TEXT);
  if (!m) return body;
  const line = t`I invited you to project "${m[1]}".`;
  return m[2] ? `${line}\n\n${m[2]}` : line;
}

export function renderDesktopNotification(payload: NotificationPayload): void {
  const title = payload.title || APP_NAME;
  const body = localizedBody(payload.body || '');

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
  const level = payload.level ?? 'info';
  notify({
    level,
    title,
    message: body,
    icon: payload.icon,
    actions: href ? [{ label: t`Open`, href }] : undefined,
    // A backend that sends an alert through THIS channel is telling the person, on purpose,
    // that something they are waiting on did not happen — the only word they will get, which
    // is what `forceToast` is reserved for. Ambient alerts do not come through here.
    forceToast: level !== 'info',
  });
}
