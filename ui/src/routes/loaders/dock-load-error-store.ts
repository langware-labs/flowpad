import { useSyncExternalStore } from 'react';
import type { DockPointer } from '@src/navigation';

export interface DockLoadErrorEntry {
  kind: string;
  severity: 'hard' | 'soft';
  source: string;
  title: string;
  message: string;
  retryable: boolean;
  updatedAt: number;
}

const entries = new Map<string, DockLoadErrorEntry>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, DockLoadErrorEntry> = new Map();

export function dockLoadErrorKey(dock: DockPointer | null | undefined): string | null {
  if (!dock?.viewType) return null;
  return dock.tabHash ?? `${dock.viewType}|${dock.pointer ?? ''}`;
}

function notifyListeners(): void {
  snapshot = new Map(entries);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ReadonlyMap<string, DockLoadErrorEntry> {
  return snapshot;
}

export function setDockLoadError(
  dock: DockPointer | null | undefined,
  entry: DockLoadErrorEntry,
): void {
  const key = dockLoadErrorKey(dock);
  if (!key) return;
  entries.set(key, entry);
  notifyListeners();
}

export function clearDockLoadError(dock: DockPointer | null | undefined): void {
  const key = dockLoadErrorKey(dock);
  if (!key || !entries.delete(key)) return;
  notifyListeners();
}

export function getDockLoadError(dock: DockPointer | null | undefined): DockLoadErrorEntry | null {
  const key = dockLoadErrorKey(dock);
  return key ? entries.get(key) ?? null : null;
}

export function useDockLoadError(dock: DockPointer | null | undefined): DockLoadErrorEntry | null {
  const errorSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const key = dockLoadErrorKey(dock);
  return key ? errorSnapshot.get(key) ?? null : null;
}

export function resetDockLoadErrorsForTests(): void {
  entries.clear();
  notifyListeners();
}

