/**
 * DockPointer `lang` facility — the `?lang=<code>` prop that selects which
 * translated body of an asset to show.
 *
 * The load-bearing contract for document translation: `lang` rides in `options`
 * (like `highlight`/`viewMode`) so it is (1) URL-serializable and (2) EXCLUDED
 * from `tabHash` — switching languages must swap the body inline in the SAME
 * tab, never open a new one. Mirrors side-windows-dock-roundtrip.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const POINTER = 'editor/markdown/typeid/markdown-1';

describe('DockPointer.lang', () => {
  it('is null on a bare pointer', () => {
    expect(new DockPointer(ViewType.ASSETS, POINTER).lang).toBeNull();
  });

  it('round-trips through withLang / lang', () => {
    const dp = new DockPointer(ViewType.ASSETS, POINTER).withLang('he');
    expect(dp.lang).toBe('he');
    expect(dp.options?.lang).toBe('he');
  });

  it('withLang(null) clears the language back to the original', () => {
    const dp = new DockPointer(ViewType.ASSETS, POINTER).withLang('es').withLang(null);
    expect(dp.lang).toBeNull();
    expect(dp.options?.lang).toBeUndefined();
  });

  it('replaces the language instead of accumulating options', () => {
    const dp = new DockPointer(ViewType.ASSETS, POINTER).withLang('es').withLang('fr-CA');
    expect(dp.lang).toBe('fr-CA');
  });

  it('preserves other options', () => {
    const dp = new DockPointer(ViewType.ASSETS, POINTER, { editorMode: 'review' }).withLang('he');
    expect(dp.options?.editorMode).toBe('review');
    expect(dp.lang).toBe('he');
  });

  it('survives a URL serialize → parse cycle', () => {
    const dp = new DockPointer(ViewType.ASSETS, POINTER).withLang('zh-Hans');
    const parsed = DockPointer.fromUrl(dp.toUrl());
    expect(parsed.lang).toBe('zh-Hans');
  });

  it('does NOT change tabHash — a language switch stays in the same tab', () => {
    const base = new DockPointer(ViewType.CONVERSATION, 'doc-1');
    const he = base.withLang('he');
    const es = base.withLang('es');
    expect(he.tabHash).toBe(base.tabHash);
    expect(es.tabHash).toBe(base.tabHash);
    expect(he.tabHash).toBe(es.tabHash);
  });
});
