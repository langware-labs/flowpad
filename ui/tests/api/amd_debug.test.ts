/**
 * AMD Debug Mode Test
 *
 * Tests stepping through 10 UI elements in debug mode,
 * validating each waiting event and ID.
 */

import {
  AgenticProcessor,
  apiClient,
  ConnectionManager,
  GRAPH_API_PREFIX,
  TypeId,
  UIComponentPayload
} from '@sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

/**
 * MDO content with 10 blocking UI elements for debug stepping test
 */
const DEBUG_MDO_10_ELEMENTS = `
<!-- <flow-ui id="ui_0" uri="ui://debug/step0" params='{"index":0}'/> -->
Step 0 content

<!-- <flow-ui id="ui_1" uri="ui://debug/step1" params='{"index":1}'/> -->
Step 1 content

<!-- <flow-ui id="ui_2" uri="ui://debug/step2" params='{"index":2}'/> -->
Step 2 content

<!-- <flow-ui id="ui_3" uri="ui://debug/step3" params='{"index":3}'/> -->
Step 3 content

<!-- <flow-ui id="ui_4" uri="ui://debug/step4" params='{"index":4}'/> -->
Step 4 content

<!-- <flow-ui id="ui_5" uri="ui://debug/step5" params='{"index":5}'/> -->
Step 5 content

<!-- <flow-ui id="ui_6" uri="ui://debug/step6" params='{"index":6}'/> -->
Step 6 content

<!-- <flow-ui id="ui_7" uri="ui://debug/step7" params='{"index":7}'/> -->
Step 7 content

<!-- <flow-ui id="ui_8" uri="ui://debug/step8" params='{"index":8}'/> -->
Step 8 content

<!-- <flow-ui id="ui_9" uri="ui://debug/step9" params='{"index":9}'/> -->
Step 9 content
`;

const EXPECTED_UI_IDS = ['ui_0', 'ui_1', 'ui_2', 'ui_3', 'ui_4', 'ui_5', 'ui_6', 'ui_7', 'ui_8', 'ui_9'];

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

describe('AMD Debug Mode Test', () => {
  const signupInfo = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  it('steps through 10 UI elements in debug mode', async () => {
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    const apuTypeId = await createApuEntity();
    const processor = new AgenticProcessor(apuTypeId);

    const receivedUI: UIComponentPayload[] = [];
    const waitingHistory: string[] = [];
    let completed = false;

    processor.on('ui', (payload: UIComponentPayload) => {
      console.log(`[DEBUG-TEST] Received UI: ${payload.ui_id}`);
      receivedUI.push(payload);
    });

    processor.on('waiting', (inputId: string) => {
      console.log(`[DEBUG-TEST] Waiting for input: ${inputId}`);
      waitingHistory.push(inputId);
    });

    processor.on('complete', () => {
      console.log('[DEBUG-TEST] Execution complete');
      completed = true;
    });

    processor.on('state_change', (state) => {
      console.log(`[DEBUG-TEST] State: status=${state.status}, debug.enabled=${state.debug.enabled}`);
    });

    // Start execution in debug mode
    console.log('[DEBUG-TEST] Starting processor in debug mode...');
    await processor.start(DEBUG_MDO_10_ELEMENTS, { debug: true });

    // Verify debug mode is enabled
    expect(processor.getState().debug.enabled).toBe(true);

    // Step through each of the 10 UI elements
    for (let i = 0; i < 10; i++) {
      const expectedId = EXPECTED_UI_IDS[i];
      console.log(`[DEBUG-TEST] Step ${i}: expecting ${expectedId}`);

      // Wait for the waiting event
      await vi.waitFor(
        () => {
          if (waitingHistory.length <= i) {
            throw new Error(`Waiting for UI element ${i} (${expectedId})`);
          }
        },
        { timeout: 10000, interval: 100 },
      );

      // Validate the waiting event ID
      expect(waitingHistory[i]).toBe(expectedId);
      console.log(`[DEBUG-TEST] Step ${i}: validated waiting for ${waitingHistory[i]}`);

      // Validate the received UI payload
      expect(receivedUI[i]).toBeDefined();
      expect(receivedUI[i].ui_id).toBe(expectedId);
      expect(receivedUI[i].blocking).toBe(true);
      expect(receivedUI[i].params).toEqual({ index: i });
      console.log(`[DEBUG-TEST] Step ${i}: validated UI payload`);

      // Validate processor state
      expect(processor.getState().waitingForInput).toBe(true);
      expect(processor.getState().inputId).toBe(expectedId);
      expect(processor.getState().status).toBe('paused');

      // Send input to advance to next element
      console.log(`[DEBUG-TEST] Step ${i}: sending input to advance...`);
      await processor.sendInput({ step: i, response: `response_${i}` });
    }

    // Wait for completion
    await vi.waitFor(
      () => {
        if (!completed) throw new Error('Waiting for completion');
      },
      { timeout: 10000, interval: 100 },
    );

    // Final validation
    expect(completed).toBe(true);
    expect(processor.getState().status).toBe('complete');
    expect(processor.getState().waitingForInput).toBe(false);
    expect(waitingHistory.length).toBe(10);
    expect(receivedUI.length).toBe(10);

    // Validate all UI IDs were received in order
    for (let i = 0; i < 10; i++) {
      expect(waitingHistory[i]).toBe(EXPECTED_UI_IDS[i]);
      expect(receivedUI[i].ui_id).toBe(EXPECTED_UI_IDS[i]);
    }

    console.log('[DEBUG-TEST] All 10 steps completed and validated successfully!');

    processor.dispose();
  }, 15000);
});
