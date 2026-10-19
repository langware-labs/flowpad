import { ActionInfo, dataManager } from '@sdk';
import { renderHook, waitFor } from '@testing-library/react';
import React, { type PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAction } from '@src/hooks/use-action';

function StrictWrapper({ children }: PropsWithChildren) {
  return <React.StrictMode>{children}</React.StrictMode>;
}

describe('useAction Strict Mode lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replaces the request aborted by the development cleanup', async () => {
    let calls = 0;
    const callAction = vi.spyOn(dataManager, 'callAction').mockImplementation(async (action) => {
      calls += 1;
      if (calls > 1) return { value: 'ready' };

      return await new Promise((_resolve, reject) => {
        action.abortSignal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'CanceledError' }));
        });
      });
    });
    const action = new ActionInfo('input-dir', 'agentic_process', 'd57766ce-759a-48ba-9fa2-fad6e58af4a6');

    const hook = renderHook(() => useAction<{ value: string }>(action), {
      wrapper: StrictWrapper,
    });

    await waitFor(() => expect(hook.result.current.data).toEqual({ value: 'ready' }));
    expect(callAction).toHaveBeenCalledTimes(2);
  });
});
