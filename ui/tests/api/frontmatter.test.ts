/**
 * Frontmatter accessor API tests — via compute node fs over HTTP (no mocks).
 *
 * Proves `entity.frontmatter`-style get/set (here driven through a real
 * FrontMatterFsRef, the same backing the `slick` skill's `doc`): a write-through
 * `set('version', n)` lands on disk AND preserves the body + all other keys —
 * the guard against the `FrontMatterFsRef.save()` key-drop bug.
 */

import { TypeId, fsManager, FrontMatterFsRef, Frontmatter } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const COMPUTE_NODE_TYPEID = new TypeId('compute_node', '@local');

const SKILL_MD = `---
id: 9fe9bee3-ce84-58c1-b047-90629fa5dfd3
name: slick
description: A code design lens
tags: design
---

# slick

Body line one.
`;

describe('Frontmatter accessor', () => {
  const signupInfo = getTestSignupInfo();
  let mdPath: string;

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
    mdPath = `/tmp/flow-test-fm-${Date.now()}/SKILL.md`;
    await fsManager.writeFile(COMPUTE_NODE_TYPEID, mdPath, SKILL_MD);
  });

  afterEach(async () => {
    try {
      await fsManager.delete(COMPUTE_NODE_TYPEID, mdPath);
    } catch {
      // ignore
    }
  });

  it('get() reads frontmatter through to disk', async () => {
    const fm = new Frontmatter(new FrontMatterFsRef(mdPath, COMPUTE_NODE_TYPEID));
    await fm.load();
    expect(fm.get('name')).toBe('slick');
    expect(fm.get('description')).toBe('A code design lens');
    expect(fm.version).toBe(0); // absent → 0
  });

  it('set("version", n) writes through and preserves body + other keys', async () => {
    const fm = new Frontmatter(new FrontMatterFsRef(mdPath, COMPUTE_NODE_TYPEID));
    await fm.load();
    await fm.set('version', 7);

    // Independent re-read from disk (fresh accessor) proves persistence.
    const reloaded = new Frontmatter(new FrontMatterFsRef(mdPath, COMPUTE_NODE_TYPEID));
    await reloaded.load();
    expect(reloaded.version).toBe(7);
    // Other keys survived the write (guards the save() key-drop bug).
    expect(reloaded.get('id')).toBe('9fe9bee3-ce84-58c1-b047-90629fa5dfd3');
    expect(reloaded.get('name')).toBe('slick');
    expect(reloaded.get('description')).toBe('A code design lens');

    // Body preserved verbatim.
    const raw = await fsManager.download(COMPUTE_NODE_TYPEID, mdPath);
    expect(raw).toContain('# slick');
    expect(raw).toContain('Body line one.');
  });

  it('second set() overwrites in place, not duplicating the key', async () => {
    const fm = new Frontmatter(new FrontMatterFsRef(mdPath, COMPUTE_NODE_TYPEID));
    await fm.load();
    await fm.set('version', 2);
    await fm.set('version', 5);

    const raw = await fsManager.download(COMPUTE_NODE_TYPEID, mdPath);
    const occurrences = raw.split('\n').filter((l) => l.startsWith('version:')).length;
    expect(occurrences).toBe(1);
    expect(fm.version).toBe(5);
  });
});
