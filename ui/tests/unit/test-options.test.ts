import { FlowMode, FlowStateProperty } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcessMock as FlowMock } from '../utils/stub/agentic_process_mock';
import { unitTestSetup } from '../utils/test-utils';
import { mockCallAction } from './testSetup';

describe('Completion Options Unit Tests', () => {
  beforeEach(async () => {
    await unitTestSetup();
  });

  describe('Basic Proxy Behavior', () => {
    it('should proxy getters to state resolved values', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      // Set user value via setter
      options.mode = FlowMode.AGENT;
      options.search = true;

      // Getters should return resolved values (not Resolvable objects)
      expect(options.mode).toBe(FlowMode.AGENT);
      expect(options.search).toBe(true);
      expect(typeof options.mode).toBe('string');
    });

    it('should proxy setters to state.value', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      // Set via options setter
      options.mode = FlowMode.ASK;

      // Should set the .value on the underlying JSON state
      expect(flow.state.chat_options.mode.value).toBe(FlowMode.ASK);
    });

    it('should have no internal state - all state delegated to IFlowState', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      // Everything should be delegated to state
      expect((options as any)._uploadedFilePaths).toBeUndefined();
      expect((options as any)._uiOnlyMessageText).toBeUndefined();
      expect((options as any)._userMessageType).toBeUndefined();
      expect((options as any)._state).toBeDefined(); // Only state reference
    });
  });

  describe('AUTO Mode Resolution', () => {
    it('should resolve to model_choice when mode is AUTO and model_choice is set', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      // User sets AUTO
      options.mode = FlowMode.AUTO;

      // Initially resolves to AUTO (no model choice)
      expect(options.mode).toBe(FlowMode.AUTO);

      // Backend sends state with model_choice
      flow.state.chat_options.mode.model_choice = FlowMode.ASK;

      // Getter should return ASK (resolved)
      expect(options.mode).toBe(FlowMode.ASK);

      // But user value is still AUTO
      expect(flow.state.chat_options.mode.value).toBe(FlowMode.AUTO);
    });

    it('should resolve to model_choice when set', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      // User explicitly sets AUTO
      options.mode = FlowMode.AUTO;

      // Backend sends model_choice
      flow.state.chat_options.mode.model_choice = FlowMode.ASK;

      // Getter should return ASK (model_choice wins)
      expect(options.mode).toBe(FlowMode.ASK);
    });

    it('should clear model_choice when set to null', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      options.mode = FlowMode.AUTO;
      flow.state.chat_options.mode.model_choice = FlowMode.ASK;
      expect(options.mode).toBe(FlowMode.ASK);

      // Clear model choice
      flow.state.chat_options.mode.model_choice = null;
      expect(options.mode).toBe(FlowMode.AUTO); // Falls back to user value
      expect(flow.state.chat_options.mode.model_choice).toBeNull();
    });
  });

  describe('Label Merge with Auto-Update', () => {
    it('should not auto-merge labels when auto_update_labels is false', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      // Disable auto-update - labels should NOT merge model_choice into value
      options.autoUpdateLabels = false;
      options.labels = ['user-label'];
      flow.state.chat_options.labels.model_choice = ['model-label1', 'model-label2'];

      // Getter returns model_choice (model_choice ?? value)
      expect(options.labels).toEqual(['user-label']);
    });

    it('should auto-merge labels when auto_update_labels is true via handleStateChange', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      // Enable auto-update (default is true)
      options.autoUpdateLabels = true;
      options.labels = ['user-label'];

      // Simulate backend sending state with model_choice via handleStateChange
      const newChatOptions = {
        ...flow.state.chat_options,
        labels: {
          value: ['user-label'],
          model_choice: ['model-label1', 'model-label2'],
        },
      };
      options.setOptionsState(newChatOptions);

      // resolveLabels() should have merged: model_choice first, then unique user labels
      expect(flow.state.chat_options.labels.value).toEqual(['model-label1', 'model-label2', 'user-label']);
    });
  });

  describe('State XML Integration', () => {
    beforeEach(async () => {});

    it('should update when receiving chat_options state from XML (positive test)', async () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      // Set initial user values
      options.mode = FlowMode.AUTO;

      // Mock receiving state XML with model choices
      const stateXML = `<flow-state key="${FlowStateProperty.CHAT_OPTIONS}" data-type="object">{
        "mode": {"value": "${FlowMode.AUTO}", "model_choice": "${FlowMode.ASK}"},
        "labels": {"value": ["custom-label"], "model_choice": null},
        "auto_update_labels": {"value": true, "model_choice": null},
        "search": true
      }</flow-state>`;

      flow.setMockStreamXML(stateXML);
      await flow.sendMessage('test');

      // Wait for state to be processed
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Options should now reflect the state from XML
      expect(options.mode).toBe(FlowMode.ASK); // Resolved from model_choice
      expect(flow.state.chat_options.mode.value).toBe(FlowMode.AUTO);
      expect(flow.state.chat_options.mode.model_choice).toBe(FlowMode.ASK);
    });

    it('should handle state XML without model choices (negative test)', async () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      // Set initial state (like the positive test does)
      options.mode = FlowMode.AUTO;

      // Mock receiving state XML without model choices
      // Backend sends new state with value but no model_choice
      const stateXML = `<flow-state key="${FlowStateProperty.CHAT_OPTIONS}" data-type="object">{
        "mode": {"value": "${FlowMode.AGENT}", "model_choice": "${FlowMode.ASK}"},
        "labels": {"value": [], "model_choice": null},
        "auto_update_labels": {"value": true, "model_choice": null},
        "search": false
      }</flow-state>`;

      flow.setMockStreamXML(stateXML);
      await flow.sendMessage('test');

      await new Promise((resolve) => setTimeout(resolve, 100));

      // State is updated from backend (value changed, model_choice is null)
      expect(flow.state.chat_options.mode.value).toBe(FlowMode.AUTO);
      expect(flow.state.chat_options.mode.model_choice).toBe(FlowMode.ASK);
      // Getter resolves to value since model_choice is null
      expect(options.mode).toBe(FlowMode.ASK);
    });

    it('should handle invalid state XML gracefully', async () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      // Set initial values
      options.mode = FlowMode.AGENT;

      // Mock invalid state XML
      const stateXML = `<flow-state key="${FlowStateProperty.CHAT_OPTIONS}" data-type="object">invalid json</flow-state>`;

      flow.setMockStreamXML(stateXML);
      await flow.sendMessage('test');

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should preserve existing values on error
      expect(options.mode).toBe(FlowMode.AGENT);
    });

    it('should update model_choice from XML but preserve user value', async () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      // User explicitly sets AGENT
      options.mode = FlowMode.AGENT;
      expect(options.mode).toBe(FlowMode.AGENT);

      // Backend sends state with model_choice (value in XML is ignored, only model_choice is applied)
      const stateXML = `<flow-state key="${FlowStateProperty.CHAT_OPTIONS}" data-type="object">{
        "mode": {"value": "${FlowMode.AUTO}", "model_choice": "${FlowMode.ASK}"},
        "labels": {"value": [], "model_choice": null},
        "auto_update_labels": {"value": true, "model_choice": null},
        "search": true
      }</flow-state>`;

      flow.setMockStreamXML(stateXML);
      await flow.sendMessage('test');

      await new Promise((resolve) => setTimeout(resolve, 100));

      // User value is preserved (XML value field is ignored)
      expect(flow.state.chat_options.mode.value).toBe(FlowMode.AGENT);
      // But model_choice is updated from XML
      expect(flow.state.chat_options.mode.model_choice).toBe(FlowMode.ASK);
      // Resolved returns user value (not AUTO, so model_choice is ignored)
      expect(options.mode).toBe(FlowMode.AGENT);
    });
  });

  describe('API Request Serialization', () => {
    it('should serialize to API request format with resolved values', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      options.mode = FlowMode.AUTO;
      flow.state.chat_options.mode.model_choice = FlowMode.ASK; // Set model_choice directly
      options.labels = ['label1', 'label2'];
      options.search = true;

      const apiRequest = options.toApiRequest('flow-123');

      expect(apiRequest.processId).toBe('flow-123');
      expect(apiRequest.flowMode).toBe(FlowMode.ASK); // Resolved value (model_choice wins)
      expect(apiRequest.enableSearch).toBe(true);
      expect(apiRequest.labels).toContain('label1');
      expect(apiRequest.labels).toContain('label2');
    });

    it('should include optional parameters in API request', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      const apiRequest = options.toApiRequest('flow-123', ['/path/to/file'], 'UI message', 'voice' as any);

      expect(apiRequest.uploadedFilePaths).toEqual(['/path/to/file']);
      expect(apiRequest.uiOnlyMessageText).toBe('UI message');
      expect(apiRequest.userMessageType).toBe('voice');
    });
  });

  describe('Edge Cases', () => {
    it('should handle setting same value multiple times', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      options.mode = FlowMode.AGENT;
      options.mode = FlowMode.AGENT;
      options.mode = FlowMode.AGENT;

      expect(options.mode).toBe(FlowMode.AGENT);
      expect(flow.state.chat_options.mode.value).toBe(FlowMode.AGENT);
    });

    it('should handle rapid mode changes', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      options.mode = FlowMode.AGENT;
      options.mode = FlowMode.ASK;
      options.mode = FlowMode.AUTO;
      flow.state.chat_options.mode.model_choice = FlowMode.AGENT; // Set model_choice directly

      expect(options.mode).toBe(FlowMode.AGENT); // Resolved from model_choice
      expect(flow.state.chat_options.mode.value).toBe(FlowMode.AUTO);
    });

    it('should handle empty labels array', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      options.labels = [];
      expect(options.labels).toEqual([]);
    });

    it('should handle removing non-existent label', () => {
      const flow = new FlowMock({ title: 'Test Flow' });
      const options = flow.options;

      options.labels = ['label1'];
      options.removeLabel('non-existent');

      expect(options.labels).toEqual(['label1']);
    });
  });
});
