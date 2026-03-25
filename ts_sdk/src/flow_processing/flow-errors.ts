import { FlowData } from './flow-data';

/**
 * Flow error enumeration for better error reporting and handling
 */
export enum FlowError {
  // JSON parsing errors
  INVALID_JSON_FORMAT = 'Invalid JSON format',
  JSON_PARSING_FAILED = 'JSON parsing failed',
  MALFORMED_JSON = 'Malformed JSON structure',

  // Entity data errors
  ENTITY_MISSING_TYPE_FIELD = 'Entity data missing required type field',
  ENTITY_MISSING_CONTENT = 'Entity data type requires content but got empty string',
  ENTITY_INVALID_JSON = 'Invalid entity JSON format',
  ENTITY_LOAD_FAILED = 'Failed to load entity',
  ENTITY_NULL_OR_UNDEFINED = 'Parsed entity JSON resulted in null or undefined value',

  // Object data errors
  OBJECT_MISSING_CONTENT = 'Object data type requires content but got empty string',
  OBJECT_NULL_OR_UNDEFINED = 'Parsed JSON resulted in null or undefined value',

  // Processing errors
  UNEXPECTED_PARSING_ERROR = 'Unexpected error during parsing',
  INCOMPLETE_STREAM = 'Incomplete stream',
  STREAM_PROCESSING_ERROR = 'Stream processing error',

  // Constructor/Registration errors
  ENTITY_CONSTRUCTOR_NOT_FOUND = 'Entity constructor not found for type',
  UNKNOWN_ENTITY_TYPE = 'Unknown entity type',

  // Artifact and state errors
  ARTIFACT_CREATION_FAILED = 'Artifact creation failed',
  STATE_UPDATE_FAILED = 'State update failed',
  ENTITY_DATA_INVALID = 'Entity data is invalid',
}

/**
 * Standardized Flow error event payload
 */
export interface FlowErrorEvent {
  error: FlowError;
  message: string;
  flowData?: FlowData;
  originalError?: Error;
}

/**
 * Flow error utility class for creating standardized error messages
 */
export class FlowErrorUtils {
  static createError(errorType: FlowError, details?: string): Error {
    const message = details ? `${errorType}: ${details}` : errorType;
    return new Error(message);
  }

  static createJSONError(originalError: any): Error {
    return this.createError(FlowError.INVALID_JSON_FORMAT, originalError.toString());
  }

  static createEntityError(details?: string): Error {
    return this.createError(FlowError.ENTITY_LOAD_FAILED, details);
  }

  static isFlowError(error: Error, errorType: FlowError): boolean {
    return error.message.includes(errorType);
  }

  /**
   * Create a standardized FlowErrorEvent object
   */
  static createErrorEvent(
    error: FlowError,
    message: string,
    flowData?: FlowData,
    originalError?: Error,
  ): FlowErrorEvent {
    return {
      error,
      message,
      flowData,
      originalError,
    };
  }

  /**
   * Create FlowErrorEvent from an Error object
   */
  static fromError(originalError: unknown, error: FlowError, flowData?: FlowData): FlowErrorEvent {
    const message =
      originalError instanceof Error
        ? originalError.message
        : typeof originalError === 'string'
          ? originalError
          : String(originalError);

    return this.createErrorEvent(error, message, flowData, originalError instanceof Error ? originalError : undefined);
  }
}
