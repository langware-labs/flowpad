import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager, FlowMessage, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';

const OLD_ID = '5b0f6f1e-3c1a-4c55-9a51-3a0f7f0d6a11';
const NEW_ID = '8c2d4b7a-1e9f-4b3c-8d6e-2f4a5b6c7d81';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// A stream inbox row resolves its latest message with `useEntity(latestPointer)`. When a new message
// lands the pointer moves; the row hides while that message is missing. A message the cache already
// holds must be there on the very render the pointer moves — not one commit later.
describe('useEntity on a cached target', () => {
  it('answers from the cache on the first render after a TypeId switch, without fetching', () => {
    const oldTypeId = new TypeId(FlowMessage.type, OLD_ID);
    const newTypeId = new TypeId(FlowMessage.type, NEW_ID);
    const cached = new Map([
      [OLD_ID, new FlowMessage({ id: OLD_ID })],
      [NEW_ID, new FlowMessage({ id: NEW_ID })],
    ]);
    vi.spyOn(dataManager, 'getByTypeIdFromCache').mockImplementation(((t: TypeId) => cached.get(t.id) ?? null) as never);
    vi.spyOn(dataManager, 'subscribe').mockReturnValue(() => {});
    const fetch = vi.spyOn(dataManager, 'getByTypeId');

    const seen: unknown[] = [];
    const hook = renderHook(
      ({ typeId }) => {
        const result = useEntity<FlowMessage>(typeId);
        seen.push(result.data);
        return result;
      },
      { initialProps: { typeId: oldTypeId } },
    );
    expect(hook.result.current.data).toBe(cached.get(OLD_ID));

    seen.length = 0;
    hook.rerender({ typeId: newTypeId });
    expect(seen).not.toContain(undefined);
    expect(hook.result.current.data).toBe(cached.get(NEW_ID));
    expect(hook.result.current.isLoading).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
