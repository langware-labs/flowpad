import { apiClient, ConnectionManager, FlowData, GRAPH_API_PREFIX, IEntity, Bookmark } from '@sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

async function waitForConnection(manager: ConnectionManager) {
  await vi.waitFor(
    () => {
      if (!manager.connected) throw new Error('Cannot connect to ws server');
      console.log('Connected to ws server');
    },
    {
      timeout: 5000,
      interval: 500,
    },
  );
  expect(manager.connected).toBe(true);
}

describe('WebSocket FlowData Stream Test', () => {
  const info = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
  });

  it('receives DataOp message on entity update', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Create entity and watch it
    const bookmark = new Bookmark({ title: 'initial bookmark title' });
    await bookmark.save();
    await bookmark.watch();

    // Track update via REST
    const newTitle = 'updated title ' + Date.now();
    const endpoint = `${GRAPH_API_PREFIX}/${Bookmark.type}/${bookmark.id}`;
    const newEntityJson = (await apiClient.patch<IEntity>(endpoint, {
      title: newTitle,
    })) as IEntity;
    expect(newEntityJson).toBeTruthy();
    expect(newEntityJson['title']).toEqual(newTitle);

    // Validate DataOp message arrived and updated the entity
    await vi.waitUntil(() => bookmark.title === newTitle, {
      timeout: 5000,
      interval: 100,
    });

    expect(bookmark.title).toBe(newTitle);
  }, 10000);

  it('receives FlowData on entity delete', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Create entity and watch it
    const bookmark = new Bookmark({ title: 'Test Bookmark for Delete' });
    await bookmark.save();
    await bookmark.watch();

    // Verify entity has default stream
    expect(bookmark.flowDataStream).toBeDefined();
    expect(bookmark.flowDataStream.count).toBe(0);

    // Track FlowData reception
    let flowDataReceived = false;
    let _receivedFlowData: FlowData | null = null;
    bookmark.on('flow_data', (data: FlowData) => {
      flowDataReceived = true;
      _receivedFlowData = data;
    });

    // Delete entity - backend sends FlowData notification before delete
    await bookmark.delete();

    // Validate FlowData arrived
    await vi.waitFor(
      () => {
        if (!flowDataReceived) throw new Error('FlowData not received');
      },
      { timeout: 5000, interval: 100 },
    );

    expect(flowDataReceived).toBe(true);
    expect(bookmark.flowDataStream.count).toBe(1);

    // Check the FlowData content
    const items = bookmark.flowDataStream.items;
    expect(items.length).toBe(1);
    expect(items[0].elementType).toBe('notification');
    expect(items[0].attributes['event']).toBe('entity_deleted');
    expect(items[0].attributes['entity_id']).toBe(bookmark.id);
  }, 15000);

  it('multiple entities receive independent FlowData streams', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Create two entities
    const bookmark1 = new Bookmark({ title: 'Test Bookmark 1' });
    const bookmark2 = new Bookmark({ title: 'Test Bookmark 2' });
    await bookmark1.save();
    await bookmark2.save();
    await bookmark1.watch();
    await bookmark2.watch();

    // Verify each entity has its own stream
    expect(bookmark1.flowDataStream.id).not.toBe(bookmark2.flowDataStream.id);
    expect(bookmark1.flowDataStream.count).toBe(0);
    expect(bookmark2.flowDataStream.count).toBe(0);

    // Track FlowData for bookmark1 only
    let bookmark1FlowDataReceived = false;
    bookmark1.on('flow_data', () => {
      bookmark1FlowDataReceived = true;
    });

    // Delete bookmark1 - should only affect bookmark1's stream
    await bookmark1.delete();

    await vi.waitFor(
      () => {
        if (!bookmark1FlowDataReceived) throw new Error('FlowData not received for bookmark1');
      },
      { timeout: 5000, interval: 100 },
    );

    expect(bookmark1.flowDataStream.count).toBe(1);
    expect(bookmark2.flowDataStream.count).toBe(0);
  }, 15000);
});
