import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A `node_modules/node_modules` link makes Vite's dep optimizer reach one
// package through several paths and bundle each as its own copy. Milkdown
// then holds two `@milkdown/core` instances, so `nodesCtx` injected by one is
// "not found" by the other and every markdown editor renders empty.
const ROOTS = ['../..', '../../../ts_sdk'].map((p) => resolve(__dirname, p, 'node_modules'));

describe('node_modules layout', () => {
  it.each(ROOTS)('%s has no nested node_modules entry', (root) => {
    const nested = resolve(root, 'node_modules');
    const present = existsSync(nested) || (() => { try { return !!lstatSync(nested); } catch { return false; } })();
    expect(present, `${nested} must not exist — it duplicates every package for Vite`).toBe(false);
  });
});
