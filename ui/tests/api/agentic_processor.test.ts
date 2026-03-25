/**
 * AgenticProcessor API Test
 *
 * Tests the APU (Agentic Processing Unit) entity with real backend execution.
 * Uses the shared WebSocket ConnectionManager and REST API messages.
 */

import {
  AgenticProcessor,
  apiClient,
  ConnectionManager,
  FlowData,
  GRAPH_API_PREFIX,
  ProcessorStatus,
  TypeId,
  UIComponentPayload,
  UIHandler,
} from '@sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

/**
 * MDO content with 3 UI components:
 * 1. ui1 - blocking form (default behavior)
 * 2. ui2 - non-blocking display
 * 3. ui3 - blocking form
 */
const TEST_MDO_CONTENT = `
<!-- <flow-ui id="ui1" uri="ui://test/form1" params='{"title":"First Form"}'/> -->
First blocking form

<!-- <flow-ui id="ui2" uri="ui://test/display" non-blocking="true" params='{"message":"Hello"}'/> -->
Non-blocking display

<!-- <flow-ui id="ui3" uri="ui://test/form2" params='{"title":"Second Form"}'/> -->
Second blocking form
`;

/**
 * Simple MDO with single blocking UI
 */
const SIMPLE_MDO_CONTENT = `
<!-- <flow-ui id="simple_ui" uri="ui://test/simple" params='{"field":"value"}'/> -->
Simple blocking UI test
`;

/**
 * Non-agentic block MDO - UI elements only, no LLM calls
 */
const NON_AGENTIC_MDO_CONTENT = `
<!-- <flow-block agentic="false"> -->
  <!-- <flow-ui id="spinner" uri="ui://spinner" non-blocking="true" /> -->
  <!-- <flow-ui id="form" uri="ui://forms/input" params='{"label":"Name"}' /> -->
  <!-- <flow-do /> -->This should be SKIPPED
<!-- </flow-block> -->
`;

async function waitForConnection(manager: ConnectionManager) {
  await vi.waitFor(
    () => {
      if (!manager.connected) throw new Error('Cannot connect to ws server');
    },
    { timeout: 5000, interval: 500 },
  );
  expect(manager.connected).toBe(true);
}

async function createApuEntity(): Promise<TypeId> {
  const response = await apiClient.post<{ type: string; id: string }>(`${GRAPH_API_PREFIX}/apu`, {});
  return new TypeId(`${response.type}-${response.id}`);
}

describe('AgenticProcessor Entity API Test', () => {
  const signupInfo = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('creates APU entity and connects via shared WebSocket', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Create APU entity
    const apuTypeId = await createApuEntity();
    expect(apuTypeId.type).toBe('apu');
    expect(apuTypeId.id).toBeTruthy();

    // Create processor for the entity
    const processor = new AgenticProcessor(apuTypeId);
    expect(processor.apuTypeId.equals(apuTypeId)).toBe(true);

    processor.dispose();
  }, 10000);

  it('executes simple MDO with single blocking UI', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    const apuTypeId = await createApuEntity();
    const processor = new AgenticProcessor(apuTypeId);
    const uiHandler = new UIHandler();
    const receivedFlowData: FlowData[] = [];
    let waitingInputId: string | null = null;
    let completed = false;

    processor.on('flow_data', (data: FlowData) => {
      console.log('[TEST] Received flow_data:', JSON.stringify(data.attributes));
      receivedFlowData.push(data);
      uiHandler.handleFlowData(data);
    });

    processor.on('waiting', (inputId: string) => {
      console.log('[TEST] Received waiting event:', inputId);
      waitingInputId = inputId;
    });

    processor.on('state_change', (state) => {
      console.log('[TEST] State changed:', JSON.stringify(state));
    });

    processor.on('complete', () => {
      console.log('[TEST] Received complete event');
      completed = true;
    });

    // Start execution
    console.log('[TEST] About to call processor.start()...');
    await processor.start(SIMPLE_MDO_CONTENT);
    console.log('[TEST] processor.start() returned');

    // Wait for UI and waiting state
    console.log('[TEST] About to call vi.waitFor...');
    await vi.waitFor(
      () => {
        console.log('[TEST-WAITFOR] waitingInputId:', waitingInputId, 'uiHandler.count:', uiHandler.count);
        if (!waitingInputId) throw new Error('Still waiting for input request');
      },
      { timeout: 10000, interval: 100 },
    );
    console.log('[TEST] vi.waitFor completed!');

    // Verify we received the UI FlowData
    console.log('[TEST] uiHandler.count:', uiHandler.count);
    console.log(
      '[TEST] components:',
      JSON.stringify(uiHandler.getComponents().map((c) => ({ ui_id: c.ui_id, params: c.params }))),
    );
    const component = uiHandler.getComponentById('simple_ui');
    console.log('[TEST] component:', JSON.stringify(component));
    expect(uiHandler.count).toBe(1);
    expect(component).toBeDefined();
    expect(component?.uri).toBe('ui://test/simple');
    expect(component?.blocking).toBe(true);
    expect(component?.params).toEqual({ field: 'value' });

    // Verify processor is waiting
    expect(processor.getState().waitingForInput).toBe(true);
    expect(waitingInputId).toBe('simple_ui');

    // Send input to continue
    console.log('[TEST] About to call sendInput...');
    try {
      await processor.sendInput({ response: 'user input' });
      console.log('[TEST] sendInput completed successfully');
    } catch (err) {
      console.error('[TEST] sendInput threw error:', err);
      throw err;
    }

    // Wait for completion
    await vi.waitFor(
      () => {
        if (!completed) throw new Error('Still waiting for completion');
      },
      { timeout: 10000, interval: 100 },
    );

    expect(completed).toBe(true);
    expect(processor.getState().status).toBe('complete');

    processor.dispose();
  }, 15000);

  it('executes non-agentic block without LLM calls', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    const apuTypeId = await createApuEntity();
    const processor = new AgenticProcessor(apuTypeId);
    const uiHandler = new UIHandler();
    const receivedFlowData: FlowData[] = [];
    let waitingInputId: string | null = null;

    processor.on('flow_data', (data: FlowData) => {
      receivedFlowData.push(data);
      uiHandler.handleFlowData(data);
    });

    processor.on('waiting', (inputId: string) => {
      waitingInputId = inputId;
    });

    // Start execution
    await processor.start(NON_AGENTIC_MDO_CONTENT);

    // Wait for blocking UI
    await vi.waitFor(
      () => {
        if (!waitingInputId) throw new Error('Still waiting for input request');
      },
      { timeout: 10000, interval: 100 },
    );

    // Should have received spinner (non-blocking) and form (blocking)
    // flow-do should be SKIPPED in non-agentic block
    expect(uiHandler.count).toBe(2);
    expect(uiHandler.getNonBlockingComponents().length).toBe(1);
    expect(uiHandler.getBlockingComponents().length).toBe(1);

    // Verify spinner
    const spinner = uiHandler.getComponentById('spinner');
    expect(spinner).toBeDefined();
    expect(spinner?.uri).toBe('ui://spinner');
    expect(spinner?.blocking).toBe(false);

    // Verify form
    const form = uiHandler.getComponentById('form');
    expect(form).toBeDefined();
    expect(form?.uri).toBe('ui://forms/input');
    expect(form?.blocking).toBe(true);

    // Verify waiting for form input
    expect(waitingInputId).toBe('form');

    processor.dispose();
  }, 15000);

  it('executes 3 UI components with correct blocking behavior', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    const apuTypeId = await createApuEntity();
    const processor = new AgenticProcessor(apuTypeId);
    const uiHandler = new UIHandler();
    const receivedUI: UIComponentPayload[] = [];
    const waitingHistory: string[] = [];
    let completed = false;

    processor.on('ui', (payload: UIComponentPayload) => {
      receivedUI.push(payload);
    });

    processor.on('flow_data', (data: FlowData) => {
      uiHandler.handleFlowData(data);
    });

    processor.on('waiting', (inputId: string) => {
      waitingHistory.push(inputId);
    });

    processor.on('complete', () => {
      completed = true;
    });

    // Start execution
    await processor.start(TEST_MDO_CONTENT);

    // Wait for first blocking UI (ui1)
    await vi.waitFor(
      () => {
        if (waitingHistory.length === 0) throw new Error('Waiting for first blocking UI');
      },
      { timeout: 10000, interval: 100 },
    );

    // Should have received ui1 only
    expect(receivedUI.length).toBe(1);
    expect(receivedUI[0].ui_id).toBe('ui1');
    expect(receivedUI[0].blocking).toBe(true);
    expect(waitingHistory[0]).toBe('ui1');

    // Verify processor state
    expect(processor.getState().waitingForInput).toBe(true);
    expect(processor.getState().inputId).toBe('ui1');

    // Send input for ui1
    await processor.sendInput({ answer: 'first response' });

    // Wait for ui2 (non-blocking) and ui3 (blocking)
    await vi.waitFor(
      () => {
        if (waitingHistory.length < 2) throw new Error('Waiting for second blocking UI');
      },
      { timeout: 10000, interval: 100 },
    );

    // Should have received ui2 AND ui3 (ui2 is non-blocking so doesn't pause)
    expect(receivedUI.length).toBe(3);
    expect(receivedUI[1].ui_id).toBe('ui2');
    expect(receivedUI[1].blocking).toBe(false);
    expect(receivedUI[2].ui_id).toBe('ui3');
    expect(receivedUI[2].blocking).toBe(true);

    // Second waiting should be for ui3 (ui2 didn't cause waiting)
    expect(waitingHistory[1]).toBe('ui3');

    // Send input for ui3
    await processor.sendInput({ answer: 'second response' });

    // Wait for completion
    await vi.waitFor(
      () => {
        if (!completed) throw new Error('Waiting for completion');
      },
      { timeout: 10000, interval: 100 },
    );

    // Verify final state
    expect(completed).toBe(true);
    expect(processor.getState().status).toBe('complete');
    expect(processor.getState().waitingForInput).toBe(false);

    // Verify UIHandler processed all components
    expect(uiHandler.count).toBe(3);
    expect(uiHandler.getBlockingComponents().length).toBe(2);
    expect(uiHandler.getNonBlockingComponents().length).toBe(1);

    processor.dispose();
  }, 15000);

  it('handles error when sending input without waiting', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    const apuTypeId = await createApuEntity();
    const processor = new AgenticProcessor(apuTypeId);

    // Try to send input without executing - should throw
    await expect(processor.sendInput({ data: 'test' })).rejects.toThrow('Processor not waiting for input');

    processor.dispose();
  }, 10000);

  it('receives correct FlowData attributes', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    const apuTypeId = await createApuEntity();
    const processor = new AgenticProcessor(apuTypeId);
    const flowDataList: FlowData[] = [];
    let waitingInputId: string | null = null;

    processor.on('flow_data', (data: FlowData) => {
      flowDataList.push(data);
    });

    processor.on('waiting', (inputId: string) => {
      waitingInputId = inputId;
    });

    await processor.start(SIMPLE_MDO_CONTENT);

    // Wait for waiting state
    await vi.waitFor(
      () => {
        if (!waitingInputId) throw new Error('Waiting for input request');
      },
      { timeout: 10000, interval: 100 },
    );

    // Verify FlowData attributes
    const uiFlowData = flowDataList.find((fd) => fd.attributes['element-type'] === 'ui');
    expect(uiFlowData).toBeDefined();
    expect(uiFlowData?.attributes['data-type']).toBe('object');
    expect(uiFlowData?.attributes['ui-id']).toBe('simple_ui');

    // Send input to complete
    await processor.sendInput({ done: true });

    await vi.waitFor(
      () => {
        if (processor.getState().status !== ProcessorStatus.COMPLETE) throw new Error('Waiting for completion');
      },
      { timeout: 10000, interval: 100 },
    );

    processor.dispose();
  }, 15000);

  it('getReceivedFlowData returns all received data', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    const apuTypeId = await createApuEntity();
    const processor = new AgenticProcessor(apuTypeId);
    let waitingInputId: string | null = null;

    processor.on('waiting', (inputId: string) => {
      waitingInputId = inputId;
    });

    await processor.start(SIMPLE_MDO_CONTENT);

    // Wait for waiting state
    await vi.waitFor(
      () => {
        if (!waitingInputId) throw new Error('Waiting for input request');
      },
      { timeout: 10000, interval: 100 },
    );

    // Check getReceivedFlowData
    const receivedData = processor.getReceivedFlowData();
    expect(receivedData.length).toBeGreaterThan(0);

    // Find UI data
    const uiData = receivedData.find((fd) => fd.attributes['element-type'] === 'ui');
    expect(uiData).toBeDefined();

    // Send input and complete
    await processor.sendInput({ done: true });

    await vi.waitFor(
      () => {
        if (processor.getState().status !== ProcessorStatus.COMPLETE) throw new Error('Waiting for completion');
      },
      { timeout: 10000, interval: 100 },
    );

    processor.dispose();
  }, 15000);

  it('can abort execution', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    const apuTypeId = await createApuEntity();
    const processor = new AgenticProcessor(apuTypeId);
    let waitingInputId: string | null = null;

    processor.on('waiting', (inputId: string) => {
      waitingInputId = inputId;
    });

    await processor.start(SIMPLE_MDO_CONTENT);

    // Wait for waiting state
    await vi.waitFor(
      () => {
        if (!waitingInputId) throw new Error('Waiting for input request');
      },
      { timeout: 10000, interval: 100 },
    );

    // Abort
    await processor.abort();

    // Verify aborted
    expect(processor.getState().status).toBe('idle');
    expect(processor.getState().waitingForInput).toBe(false);

    processor.dispose();
  }, 15000);
});
