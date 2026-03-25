import { Flow } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { unitTestSetup } from '../../utils/test-utils';

describe('Resolvable Labels Tests', () => {
  let flow: Flow;

  beforeEach(async () => {
    await unitTestSetup();

    // Create a Flow instance for testing
    flow = new Flow();
  });

  describe('Test 1: Resolvable Pattern Basics', () => {
    it('should initialize labels as empty Resolvable', () => {
      const options = flow.options;
      // options.labels returns the resolved value (array), not the Resolvable
      expect(options.labels).toEqual([]);
      // flow.state.chat_options.labels has value and model_choice properties
      expect(flow.state.chat_options.labels).toHaveProperty('value');
      expect(flow.state.chat_options.labels).toHaveProperty('model_choice');
      expect(flow.state.chat_options.labels.value).toEqual([]);
      expect(flow.state.chat_options.labels.model_choice).toBeNull();
      expect(flow.options.labels).toEqual([]);
    });

    it('should merge labels.value with modelChoice when autoUpdateLabels is true', () => {
      const options = flow.options;
      const labelsResolvable = flow.state.chat_options.labels;

      // User adds a label
      options.addLabel('UserLabel');
      expect(labelsResolvable.value).toEqual(['UserLabel']);

      // Backend sends modelChoice (autoUpdateLabels is true by default)
      flow.state.chat_options.labels.model_choice = ['BackendLabel'];
      options.setOptionsState(flow.state.chat_options);

      // With autoUpdateLabels=true, value gets merged
      expect(labelsResolvable.value).toEqual(['BackendLabel', 'UserLabel']); // Merged into value
      expect(labelsResolvable.model_choice).toEqual(['BackendLabel']);
    });
  });

  describe('Test 6: Edge Cases', () => {
    it('should handle empty arrays correctly', () => {
      // Set empty arrays
      flow.options.labels = [];
      flow.state.chat_options.labels.model_choice = [];
      flow.options.setOptionsState(flow.state.chat_options);

      expect(flow.options.labels).toEqual([]);
    });

    it('should handle null modelChoice', () => {
      flow.options.addLabel('UserLabel');
      flow.state.chat_options.labels.model_choice = null;
      flow.options.setOptionsState(flow.state.chat_options);

      // Should fall back to value
      expect(flow.options.labels).toEqual(['UserLabel']);
    });
  });
});
