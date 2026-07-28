import type { WikiResolveResult } from '@sdk';
import type { WikiAuthority } from '@src/components/wiki/resolve-wiki';
import { useSyncExternalStore } from 'react';

const results = new Map<string, WikiResolveResult>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, WikiResolveResult> = new Map();

export function wikiResolveKey(
  wikiRef: string,
  word: string,
  authority: WikiAuthority = 'local',
): string {
  return `${authority}\u0000${wikiRef}\u0000${word}`;
}

function notify(): void {
  snapshot = new Map(results);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ReadonlyMap<string, WikiResolveResult> {
  return snapshot;
}

export function setWikiResolveResult(
  wikiRef: string,
  word: string,
  result: WikiResolveResult,
  authority: WikiAuthority = 'local',
): void {
  results.set(wikiResolveKey(wikiRef, word, authority), result);
  notify();
}

export function clearWikiResolveResult(
  wikiRef: string,
  word: string,
  authority: WikiAuthority = 'local',
): void {
  if (results.delete(wikiResolveKey(wikiRef, word, authority))) notify();
}

export function getWikiResolveResult(
  wikiRef: string,
  word: string,
  authority: WikiAuthority = 'local',
): WikiResolveResult | undefined {
  return results.get(wikiResolveKey(wikiRef, word, authority));
}

export function useWikiResolveResult(
  wikiRef: string,
  word: string,
  authority: WikiAuthority = 'local',
): WikiResolveResult | undefined {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return current.get(wikiResolveKey(wikiRef, word, authority));
}

export function resetWikiResolveResultsForTests(): void {
  results.clear();
  notify();
}
