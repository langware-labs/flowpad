import { replace, redirect } from 'react-router';
import type { DockPointer } from '@src/navigation';
import { notify } from '@src/notifications';
import {
  clearDockLoadError,
  setDockLoadError,
  type DockLoadErrorEntry,
  type DockLoadErrorLink,
} from './dock-load-error-store';

export type DockLoadSeverity = 'hard' | 'soft';

export type LoadResolution =
  | {
      action: 'render_error';
      title: string;
      message: string;
      retryable?: boolean;
      link?: DockLoadErrorLink;
    }
  | { action: 'redirect'; to: string; replace?: boolean; notify?: LoadNotification }
  | { action: 'notify'; notification: LoadNotification }
  | { action: 'banner' }
  | { action: 'noop' };

export interface LoadNotification {
  level?: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
  id?: string;
}

export class DockLoadError extends Error {
  constructor(
    readonly kind: string,
    readonly severity: DockLoadSeverity,
    readonly resolution: LoadResolution,
    readonly source: string,
    readonly cause?: unknown,
  ) {
    super(`dock-load:${source}:${kind}`);
  }
}

function emitNotification(notification: LoadNotification): void {
  const level = notification.level ?? 'error';
  notify[level]({
    id: notification.id,
    title: notification.title,
    message: notification.message,
  });
}

export function isRedirectResponse(error: unknown): boolean {
  if (typeof Response !== 'undefined' && error instanceof Response) {
    return error.status >= 300 && error.status < 400 && error.headers.has('Location');
  }
  const candidate = error as { status?: number; headers?: { get?: (name: string) => string | null } } | null;
  return !!(
    candidate &&
    typeof candidate.status === 'number' &&
    candidate.status >= 300 &&
    candidate.status < 400 &&
    candidate.headers?.get?.('Location')
  );
}

export function handleDockLoadError(error: unknown, dock: DockPointer | null): void {
  if (isRedirectResponse(error)) throw error;
  if (!(error instanceof DockLoadError)) throw error;

  switch (error.resolution.action) {
    case 'render_error': {
      const entry: DockLoadErrorEntry = {
        kind: error.kind,
        severity: error.severity,
        source: error.source,
        title: error.resolution.title,
        message: error.resolution.message,
        retryable: !!error.resolution.retryable,
        link: error.resolution.link,
        updatedAt: Date.now(),
      };
      setDockLoadError(dock, entry);
      return;
    }
    case 'redirect':
      if (error.resolution.notify) emitNotification(error.resolution.notify);
      clearDockLoadError(dock);
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw (error.resolution.replace ?? true) ? replace(error.resolution.to) : redirect(error.resolution.to);
    case 'notify':
      emitNotification(error.resolution.notification);
      clearDockLoadError(dock);
      return;
    case 'banner':
    case 'noop':
      clearDockLoadError(dock);
      return;
  }
}
