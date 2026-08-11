import { ActionInfo, apiClient, dataManager, EDIT_MARK_DEBOUNCE_MS, Project } from '@sdk';
import { JSONSchemaParser } from '@sdk/FlowSync/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENTITY_ID = '21000000-0000-4000-8000-000000000001';
const OTHER_ENTITY_ID = '21000000-0000-4000-8000-000000000002';

function project(id: string, uname?: string): Project {
  return new Project({
    type: Project.type,
    id,
    uname,
    name: `Project ${id.slice(-1)}`,
    last_edited_at: 123,
  } as never);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('APIEntity.markEdit', () => {
  let previousSchema: JSONSchemaParser | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    await dataManager.reset();
    previousSchema = dataManager.schemas[Project.type];
    dataManager.schemas[Project.type] = new JSONSchemaParser({
      type: 'object',
      properties: { type: { type: 'string', default: Project.type } },
    } as never);
  });

  afterEach(async () => {
    await dataManager.reset();
    if (previousSchema) dataManager.schemas[Project.type] = previousSchema;
    else delete dataManager.schemas[Project.type];
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('coalesces aliases until one minute after the final mark', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as never);
    const byId = project(ENTITY_ID);

    byId.markEdit();
    await vi.advanceTimersByTimeAsync(30_000);

    // This separately-hydrated object addresses the same row through @uname,
    // but markEdit keys by its canonical UUID.
    const byUname = project(ENTITY_ID, 'edit-marker-project');
    byUname.markEdit();

    await vi.advanceTimersByTimeAsync(EDIT_MARK_DEBOUNCE_MS - 1);
    expect(call).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(call).toHaveBeenCalledOnce();
    const action: ActionInfo = call.mock.calls[0][0];
    expect(action.name).toBe('mark-edit');
    expect(action.method).toBe('POST');
    expect(action.targetEntity).toMatchObject({ type: Project.type, id: ENTITY_ID });
    expect(byId.last_edited_at).toBe(123);
    expect(byUname.last_edited_at).toBe(123);
  });

  it('schedules by type and id without hydrating an entity', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as never);

    Project.markEditById(ENTITY_ID);
    await vi.advanceTimersByTimeAsync(EDIT_MARK_DEBOUNCE_MS);

    expect(call.mock.calls[0][0].targetEntity).toMatchObject({
      type: Project.type,
      id: ENTITY_ID,
    });
  });

  it('serializes one entity while another entity remains independent', async () => {
    const first = deferred<unknown>();
    let heldFirstRequest = true;
    const call = vi.spyOn(dataManager, 'callAction').mockImplementation((action) => {
      if (action.targetEntity?.id === ENTITY_ID && heldFirstRequest) {
        heldFirstRequest = false;
        return first.promise as never;
      }
      return Promise.resolve({}) as never;
    });
    const one = project(ENTITY_ID);
    const two = project(OTHER_ENTITY_ID);

    one.markEdit();
    await vi.advanceTimersByTimeAsync(EDIT_MARK_DEBOUNCE_MS);
    expect(call.mock.calls.map(([action]) => action.targetEntity?.id)).toEqual([ENTITY_ID]);

    one.markEdit();
    two.markEdit();
    await vi.advanceTimersByTimeAsync(EDIT_MARK_DEBOUNCE_MS);
    expect(call.mock.calls.map(([action]) => action.targetEntity?.id)).toEqual([
      ENTITY_ID,
      OTHER_ENTITY_ID,
    ]);

    first.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(call.mock.calls.map(([action]) => action.targetEntity?.id)).toEqual([
      ENTITY_ID,
      OTHER_ENTITY_ID,
      ENTITY_ID,
    ]);
  });

  it('waits behind an already-queued full save for the same entity', async () => {
    const saveResponse = deferred<unknown>();
    const put = vi.spyOn(apiClient, 'put').mockReturnValue(saveResponse.promise as never);
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as never);
    const entity = project(ENTITY_ID);
    Object.defineProperty(entity, 'created_date', {
      value: '2026-08-11T08:00:00.000Z',
      writable: true,
      enumerable: true,
      configurable: true,
    });

    const save = entity.save();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledOnce();

    entity.markEdit();
    await vi.advanceTimersByTimeAsync(EDIT_MARK_DEBOUNCE_MS);
    expect(call).not.toHaveBeenCalled();

    saveResponse.resolve({
      type: Project.type,
      id: ENTITY_ID,
      name: entity.name,
      created_date: entity.created_date,
      last_edited_at: 123,
    });
    await save;
    await vi.advanceTimersByTimeAsync(0);

    expect(call).toHaveBeenCalledOnce();
  });

  it('cancels pending marks when the data manager resets', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as never);
    project(ENTITY_ID).markEdit();

    await dataManager.reset();
    await vi.advanceTimersByTimeAsync(EDIT_MARK_DEBOUNCE_MS);

    expect(call).not.toHaveBeenCalled();
  });
});
