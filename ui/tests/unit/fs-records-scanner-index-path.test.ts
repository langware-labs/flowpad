/**
 * Tests for FsRecordsScannerViewer component static correctness.
 *
 * Original bug: INDEX_PATH was used in indexType() and indexAll() but was never declared
 * in FsRecordsScannerViewer.tsx — causing ReferenceError at runtime.
 *
 * Current fix: component delegates to systemTools.indexType() / systemTools.indexTypes()
 * from @sdk, which manage the index path internally. This test guards against regression
 * back to inline INDEX_PATH usage without a declaration.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const VIEWER_PATH = resolve(
  __dirname,
  '../../src/components/lens-viewer/FsRecordsScannerViewer.tsx',
);

describe('FsRecordsScannerViewer index delegation', () => {
  it('should use useSystemTools hook instead of an inline INDEX_PATH', () => {
    const source = readFileSync(VIEWER_PATH, 'utf-8');

    // Verify the component delegates index calls to useSystemTools hook
    expect(source).toContain('useSystemTools');
    expect(source).toContain('indexType');
    expect(source).toContain('indexTypes');

    // Regression guard: if INDEX_PATH is used, it must be declared in this file
    if (source.includes('INDEX_PATH')) {
      const declarationPattern = /const\s+INDEX_PATH\s*=/;
      expect(declarationPattern.test(source)).toBe(true);
    }
  });
});
