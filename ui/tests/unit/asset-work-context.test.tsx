import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import {
  assetWorkContextForDock,
  useKeyedAssetPromptContext,
} from '@src/pages/flow-page/asset-work-context';

describe('asset work context', () => {
  it('grounds a raw file with its exact canonical path', () => {
    const context = assetWorkContextForDock(
      new DockPointer(ViewType.EDITOR, '/workspace/src/app.ts'),
    );

    expect(context?.label).toBe('app.ts');
    expect(context?.path).toBe('/workspace/src/app.ts');
    expect(context?.text).toContain('/workspace/src/app.ts');
  });

  it('an old in-flight consume cannot clear a newer child context', () => {
    const first = {
      key: 'markdown-first',
      label: 'first.md',
      text: 'first',
      typeId: 'markdown-first',
    };
    const second = {
      key: 'markdown-second',
      label: 'second.md',
      text: 'second',
      typeId: 'markdown-second',
    };
    const { result, rerender } = renderHook(
      ({ context }) => useKeyedAssetPromptContext(context),
      { initialProps: { context: first } },
    );
    const consumeFirst = result.current.consume;

    rerender({ context: second });
    act(() => consumeFirst(first.key));

    expect(result.current.promptContext?.key).toBe(second.key);
  });
});
