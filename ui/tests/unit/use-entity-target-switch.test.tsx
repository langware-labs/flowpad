import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager, Markdown, Skill, TypeId, type APIEntity } from '@sdk';
import { useEntity } from '@sdk/react/hooks';

const MARKDOWN_ID = 'f3330348-9050-4939-9b0e-cb193f1d3082';
const SKILL_ID = 'f29eaf7e-156f-43be-81e7-099bdca4a62a';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useEntity target changes', () => {
  it('does not expose or restore the previous entity after a TypeId switch', async () => {
    const markdownTypeId = new TypeId(Markdown.type, MARKDOWN_ID);
    const skillTypeId = new TypeId(Skill.type, SKILL_ID);
    const markdown = new Markdown({ id: MARKDOWN_ID });
    const skill = new Skill({ id: SKILL_ID });
    const markdownRequest = deferred<APIEntity<any> | null>();
    const skillRequest = deferred<APIEntity<any> | null>();

    vi.spyOn(dataManager, 'getByTypeIdFromCache').mockReturnValue(null);
    vi.spyOn(dataManager, 'subscribe').mockReturnValue(() => {});
    vi.spyOn(dataManager, 'getByTypeId').mockImplementation(async (typeId) => {
      return (typeId.equals(markdownTypeId)
        ? markdownRequest.promise
        : skillRequest.promise) as never;
    });

    const hook = renderHook(
      ({ typeId }) => useEntity(typeId),
      { initialProps: { typeId: markdownTypeId } },
    );

    hook.rerender({ typeId: skillTypeId });
    expect(hook.result.current.data).toBeUndefined();
    expect(hook.result.current.isLoading).toBe(true);

    await act(async () => {
      skillRequest.resolve(skill);
    });
    await waitFor(() => expect(hook.result.current.data).toBe(skill));

    await act(async () => {
      markdownRequest.resolve(markdown);
    });
    expect(hook.result.current.data).toBe(skill);
  });
});
