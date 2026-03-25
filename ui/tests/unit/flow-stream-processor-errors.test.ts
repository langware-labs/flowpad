import { Flow } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { FlowError } from '@sdk/flow_processing/flow-errors';
import { FlowEvents } from '@sdk/flow_processing/flow-events';
import { FlowStreamProcessor } from '@sdk/flow_processing/flow-stream-processor';

describe('FlowStreamProcessor Error Handling', () => {
  let processor: FlowStreamProcessor;
  let _flow: Flow;

  beforeEach(() => {
    processor = new FlowStreamProcessor();
    _flow = new Flow({ title: 'Test Flow' });
  });

  describe('JSON Parsing Errors', () => {
    it('should emit error for malformed JSON in entity data-type', async () => {
      const errors: any[] = [];
      processor.on(FlowEvents.ERROR, (error) => {
        errors.push(error);
      });

      // Process XML with malformed JSON
      const malformedXml = '<flow-result data-type="entity">{"type": "artifact", "id": "invalid-json"</flow-result>';
      processor.process_chunk(malformedXml);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain(FlowError.INVALID_JSON_FORMAT);
    });

    it('should emit error for invalid entity structure', async () => {
      const errors: any[] = [];
      processor.on(FlowEvents.ERROR, (error) => {
        errors.push(error);
      });

      // Process XML with invalid entity structure (missing required fields)
      const invalidEntityXml =
        '<flow-result data-type="entity">{"invalid": "structure", "missing": "required_fields"}</flow-result>';
      processor.process_chunk(invalidEntityXml);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain(FlowError.ENTITY_MISSING_TYPE_FIELD);
    });

    it('should emit error for entity with missing type field', async () => {
      const errors: any[] = [];
      processor.on(FlowEvents.ERROR, (error) => {
        errors.push(error);
      });

      // Process XML with entity missing type field
      const missingTypeXml =
        '<flow-result data-type="entity">{"id": "12345678-1234-4567-8901-123456789012", "name": "Test"}</flow-result>';
      processor.process_chunk(missingTypeXml);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain(FlowError.ENTITY_MISSING_TYPE_FIELD);
    });
  });

  describe('Unknown Entity Type Errors', () => {
    it('should emit error for unknown entity type', async () => {
      const errors: any[] = [];
      // Create a flow and connect to its processor
      const testFlow = new Flow({ title: 'Test Flow' });
      testFlow.on(FlowEvents.ERROR, (error) => {
        errors.push(error);
      });

      // Set up DATA_END listener BEFORE processing content
      const dataEndPromise = new Promise((resolve) => {
        testFlow.on(FlowEvents.DATA_END, () => resolve(undefined));
      });

      // Process XML with unknown entity type through the flow
      const unknownEntityXml =
        '<flow-result data-type="entity">{"type": "unknown_entity_type", "id": "12345678-1234-4567-8901-123456789012", "name": "Test"}</flow-result>';
      testFlow.ingestXmlChunk(unknownEntityXml);

      // Wait for data:end event to ensure content is fully processed
      await dataEndPromise;

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain(FlowError.ENTITY_CONSTRUCTOR_NOT_FOUND);
    });

    it('should emit error for unregistered entity constructor', async () => {
      const errors: any[] = [];
      // Create a flow and connect to its processor
      const testFlow = new Flow({ title: 'Test Flow' });
      testFlow.on(FlowEvents.ERROR, (error) => {
        errors.push(error);
      });

      // Process XML with entity type that has no registered constructor
      const unregisteredEntityXml =
        '<flow-result data-type="entity">{"type": "fake_entity", "id": "12345678-1234-4567-8901-123456789012", "name": "Test"}</flow-result>';
      testFlow.ingestXmlChunk(unregisteredEntityXml);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain(FlowError.ENTITY_CONSTRUCTOR_NOT_FOUND);
    });
  });

  describe('Multiple Errors Handling', () => {
    it('should handle multiple errors in sequence', async () => {
      const errors: any[] = [];
      processor.on(FlowEvents.ERROR, (error) => {
        errors.push(error);
      });

      // Process multiple chunks with different error types
      processor.process_chunk('<flow-result data-type="entity">{"invalid": "json"</flow-result>');
      processor.process_chunk(
        '<flow-result data-type="entity">{"type": "unknown_type", "id": "12345678-1234-4567-8901-123456789012"}</flow-result>',
      );
      processor.process_chunk(
        '<flow-result data-type="entity">{"id": "12345678-1234-4567-8901-123456789012", "name": "missing_type"}</flow-result>',
      );

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errors.length).toBeGreaterThan(0);
      // Should have caught multiple different error types
    });
  });

  describe('Error Recovery', () => {
    it('should continue processing after errors', async () => {
      const errors: any[] = [];
      const validData: any[] = [];

      processor.on(FlowEvents.ERROR, (error) => {
        errors.push(error);
      });

      processor.on(FlowEvents.DATA, (data) => {
        if (data.elementType === 'result' && !data.error) {
          validData.push(data);
        }
      });

      // Process mix of invalid and valid data
      processor.process_chunk('<flow-result data-type="entity">{"invalid": "json"</flow-result>');
      processor.process_chunk(
        '<flow-result data-type="entity">{"type": "artifact", "id": "12345678-1234-4567-8901-123456789012", "name": "Valid", "ref_type": "file", "path": "/test"}</flow-result>',
      );
      processor.process_chunk(
        '<flow-result data-type="entity">{"type": "unknown_type", "id": "87654321-4321-4321-8321-210987654321"}</flow-result>',
      );

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errors.length).toBeGreaterThan(0); // Should have errors
      expect(validData.length).toBeGreaterThan(0); // Should also have valid data
    });
  });
});

describe('Flow Error Integration', () => {
  let flow: Flow;

  beforeEach(() => {
    flow = new Flow({ title: 'Test Flow' });
  });

  describe('Flow Error Event Registration', () => {
    it('should register to processor error events and emit them', async () => {
      const flowErrors: any[] = [];
      flow.on(FlowEvents.ERROR, (error) => {
        flowErrors.push(error);
      });

      // Simulate flow processing with error by using the processContent method
      const mockXml = '<flow-result data-type="entity">{"invalid": "json"</flow-result>';

      // Process the malformed XML directly
      flow.ingestXmlChunk(mockXml);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(flowErrors.length).toBeGreaterThan(0);
    });
  });

  describe('Flow errorLog Array', () => {
    it('should maintain errorLog array for all errors', async () => {
      // Process multiple errors
      const mockXml =
        '<flow-result data-type="entity">{"invalid": "json"</flow-result>||<flow-result data-type="entity">{"type": "unknown_type", "id": "12345678-1234-4567-8901-123456789012"}</flow-result>';

      // Process the malformed XML directly
      flow.ingestXmlChunk(mockXml);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check if errorLog exists and has errors
      expect(flow.errorLog).toBeDefined();
      expect(Array.isArray(flow.errorLog)).toBe(true);
      expect(flow.errorLog.length).toBeGreaterThan(0);
    });

    it('should add processor errors to errorLog array', async () => {
      const initialErrorCount = flow.errorLog?.length || 0;

      const mockXml =
        '<flow-result data-type="entity">{"invalid": "structure", "missing": "required_fields"}</flow-result>';

      // Process the malformed XML directly
      flow.ingestXmlChunk(mockXml);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(flow.errorLog.length).toBeGreaterThan(initialErrorCount);
    });
  });

  describe('Flow hasErrors Property', () => {
    it('should return false when no errors', () => {
      // Fresh flow should have no errors
      expect(flow.hasErrors).toBe(false);
    });

    it('should return true when errors exist', async () => {
      const mockXml = '<flow-result data-type="entity">{"invalid": "json"</flow-result>';

      // Process the malformed XML directly
      flow.ingestXmlChunk(mockXml);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(flow.hasErrors).toBe(true);
    });

    it('should reflect errorLog length correctly', async () => {
      // Process multiple errors
      const mockXml =
        '<flow-result data-type="entity">{"invalid": "json1"</flow-result>||<flow-result data-type="entity">{"invalid": "json2"</flow-result>';

      // Process the malformed XML directly
      flow.ingestXmlChunk(mockXml);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(flow.hasErrors).toBe(flow.errorLog.length > 0);
    });
  });

  describe('Error Persistence', () => {
    it('should accumulate errors across multiple processing operations', async () => {
      // First error
      let mockXml = '<flow-result data-type="entity">{"invalid": "json1"</flow-result>';
      flow.ingestXmlChunk(mockXml);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const firstErrorCount = flow.errorLog.length;
      expect(firstErrorCount).toBeGreaterThan(0);

      // Second error
      mockXml = '<flow-result data-type="entity">{"invalid": "json2"</flow-result>';
      flow.ingestXmlChunk(mockXml);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(flow.errorLog.length).toBeGreaterThan(firstErrorCount);
      expect(flow.hasErrors).toBe(true);
    });
  });
});
