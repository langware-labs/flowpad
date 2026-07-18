import { beforeEach, describe, expect, it } from 'vitest';
import { FlowError } from '@sdk/flow_processing/flow-errors';
import { FlowEvents } from '@sdk/flow_processing/flow-events';
import { FlowStreamProcessor } from '@sdk/flow_processing/flow-stream-processor';

describe('FlowStreamProcessor Error Handling', () => {
  let processor: FlowStreamProcessor;

  beforeEach(() => {
    processor = new FlowStreamProcessor();
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
