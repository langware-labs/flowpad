import { EventEmitter } from 'events';
import { ViewType } from '../utils/ui/view-types';
import { FlowElementType, FlowElementTypes, isFlowElementType, normalizeElementType } from './flow-element-types';
import { FlowError, FlowErrorUtils } from './flow-errors';
import { FlowDataChunk, FlowDataEvents } from './flow-events';
import { decodeXMLEntities } from './xml-utilities';

export enum FlowDataType {
  Entity = 'entity',
  String = 'string',
  Object = 'object',
}

export enum FlowDataSource {
  Stream = 'stream',
  History = 'history',
  WebSocket = 'websocket', // Future
  Inject = 'inject', // Future
  Unknown = 'unknown',
}

/**
 * Standard FlowData attribute keys used in XML elements
 * Centralizes magic strings to improve type safety and discoverability
 */
export enum FlowDataAttribute {
  INDEX = 'i',
  TIMESTAMP = 't',
  FOCUS = 'focus',
  FOCUS_TYPE = 'focus-type',
  SOURCE = 'source',
  DATA_TYPE = 'data-type',
  ELEMENT_TYPE = 'element-type',
  PARTIAL_ID = 'partial-id',
  FINAL = 'final',
  EXIT_CODE = 'exit-code',
  SESSION_ID = 'session-id',
  STREAM = 'stream',
  STDOUT = 'stdout',
  STDERR = 'stderr',
  KEY = 'key',
  PATH = 'path',
  WARNING = 'warning',
  ERROR = 'error',
}

/**
 * Mapping of data-type string aliases to FlowDataType enum values
 * Handles various representations from backend/XML
 */
export const DATA_TYPE_ALIASES: Record<string, FlowDataType> = {
  json: FlowDataType.Object,
  object: FlowDataType.Object,
  entity: FlowDataType.Entity,
  text: FlowDataType.String,
  string: FlowDataType.String,
} as const;

export interface IFlowData<T = any> {
  elementType: FlowElementType; // Use this instead of tagName
  dataType: FlowDataType | null;
  data: T;
  attributes: Record<string, string>;
  rawData?: any; // Original unparsed data
  source: FlowDataSource; // Origin of this FlowData
}

export class FlowData<T = any> extends EventEmitter implements IFlowData<T> {
  private readonly xmlTagName: string; // Internal - use elementType for application logic
  public data: T = null as T;
  public isSelfClosing: boolean = false;
  public readonly attributes: Record<string, string>;
  public rawData?: any; // Store original data before parsing
  public readonly index: number; // Instance index from backend
  public readonly timestamp: string; // ISO 8601 timestamp from backend
  public readonly focus: ViewType | null; // Focus recommendation from backend
  public readonly warning: string | null; // Warning message (e.g., unknown event type)
  public readonly error_text: string | null; // Error text from backend ('error' attr; distinct from parse-error boolean)
  public source: FlowDataSource; // Origin of this FlowData (stream, history, etc.) - mutable for post-creation assignment

  // Streaming properties for data events during processing
  public last_chunk: string = ''; // Last chunk received (for debugging)

  // Element state flags
  private _isParsed: boolean = false;
  private _ready: boolean = false;
  private _error: boolean = false;
  public error_msg: string = '';

  // Preview configuration properties
  public stringPreviewLength: number = 20;
  public objectPreviewLength: number = 50;
  public introPreviewLength: number = 20;

  constructor(xmlTagName: string, rawContent: string | null = null, attributes: Record<string, string> = {}) {
    super();

    // Validate element type and warn if unknown
    if (!isFlowElementType(xmlTagName)) {
      console.warn(
        `[FlowData] Unknown element type: "${xmlTagName}". Expected one of: ${Object.values(FlowElementTypes).join(', ')}`,
      );
    }

    this.xmlTagName = xmlTagName;
    this.attributes = attributes;

    // Parse index from attributes (defaults to 0 if not provided)
    this.index = parseInt(this.attributes['i'] || '0', 10);

    // Parse timestamp from attributes (defaults to current time if not provided)
    if (!this.attributes['t']) {
      console.warn(
        `FlowData created without timestamp attribute 't' for tagName: ${this.elementType}, index: ${this.index}`,
      );
      this.timestamp = new Date().toISOString();
    } else {
      this.timestamp = this.attributes['t'];
    }

    // Parse focus from attributes (optional, null if not provided or "null" string)
    const focusAttr = this.attributes[FlowDataAttribute.FOCUS];
    this.focus = focusAttr && focusAttr !== 'null' ? (focusAttr as ViewType) : null;

    // Parse warning and error from attributes
    this.warning = this.attributes[FlowDataAttribute.WARNING] || null;
    this.error_text = this.attributes[FlowDataAttribute.ERROR] || null;

    // Parse source from attributes (defaults to 'unknown' if not provided)
    const sourceAttr = this.attributes[FlowDataAttribute.SOURCE];
    if (sourceAttr && Object.values(FlowDataSource).includes(sourceAttr as FlowDataSource)) {
      this.source = sourceAttr as FlowDataSource;
    } else {
      this.source = FlowDataSource.Unknown;
    }
    if (rawContent) {
      this.rawData = rawContent;
      this.parseElementData();
    }
  }
  public hasAttribute(attribute: string): boolean {
    return this.attributes[attribute] !== undefined;
  }
  // fromType factory method moved to FlowDataFactory to avoid circular dependencies

  /**
   * Parse a content chunk during streaming and emit chunk event
   * This method processes only the text content inside XML tags
   * Note: rawData is always a string during streaming (never called for history-loaded FlowData)
   */
  public parseChunk(contentChunk: string): void {
    if (this.ready || this._error) return; // Don't process if already ready or errored

    // Accumulate the raw XML content (rawData is always string during streaming)
    if (typeof this.rawData !== 'string') {
      this.rawData = '';
    }
    const decodedContentChunk = decodeXMLEntities(contentChunk);
    this.rawData = (this.rawData as string) + contentChunk;

    // For string types, also update this.data for consolidation scenarios
    // where data was already set (e.g., from fromJSON())
    if (this.dataType === FlowDataType.String) {
      if (typeof this.data === 'string') {
        this.data = (this.data + decodedContentChunk) as any as T;
      } else {
        this.data = decodedContentChunk as any as T;
      }
    }

    // Store last chunk for debugging
    this.last_chunk = contentChunk;

    const totalContent = decodeXMLEntities(this.rawData as string);

    // Emit chunk event with content
    const chunkData: FlowDataChunk = {
      delta: decodedContentChunk,
      totalContent,
    };
    this.emit(FlowDataEvents.CHUNK, chunkData);
  }

  /**
   * Parse object data from raw content
   */
  private parseObject(rawContent: string): void {
    if (!rawContent) {
      console.warn(`[FlowData]  ${FlowError.OBJECT_MISSING_CONTENT}`);
      return;
    }
    try {
      this.data = JSON.parse(rawContent) as T;
      if (this.data === null || this.data === undefined) {
        this._setError(FlowError.OBJECT_NULL_OR_UNDEFINED);
        return;
      }
    } catch (jsonError) {
      this._setError(FlowErrorUtils.createJSONError(jsonError).message);
      return;
    }
  }

  /**
   * Parse entity data from raw content (now emits JSON like object)
   */
  private parseEntity(rawContent: string): void {
    if (!rawContent) {
      this._setError(FlowError.ENTITY_MISSING_CONTENT);
      return;
    }
    try {
      const entityData = JSON.parse(rawContent);
      if (entityData === null || entityData === undefined) {
        this._setError(FlowError.ENTITY_NULL_OR_UNDEFINED);
        return;
      }
      if (!entityData.type) {
        this._setError(FlowError.ENTITY_MISSING_TYPE_FIELD);
        return;
      }
      // Store JSON data directly - Flow class will handle entity loading
      this.data = entityData as T;
    } catch (jsonError) {
      this._setError(FlowErrorUtils.createJSONError(jsonError).message);
      return;
    }
  }

  /**
   * Parse string data from raw content
   */
  private parseString(rawContent: string): void {
    // For string type, set data directly as the raw string
    // The content getter will handle extracting the string value
    this.data = rawContent as any as T;
  }

  /**
   * Parse the rawData based on the data-type attribute and set the data property
   * This should be called when the element is fully received (end tag closed)
   */
  public parseElementData(): void {
    if (this._isParsed || this.ready || this._error) return; // Already processed

    const dataType = this.dataType;

    // Handle case where rawData is already a parsed object (from history/websocket)
    if (typeof this.rawData === 'object' && this.rawData !== null) {
      this.data = this.rawData as T;
      this._isParsed = true;
      this.ready = true;
      this.emit(FlowDataEvents.PARSED, this.data);
      this.emit(FlowDataEvents.READY, this);
      return;
    }

    // Decode XML entities first (handles &gt;, &lt;, &amp;, etc.)
    const decodedData = decodeXMLEntities(this.rawData as string);
    // Only trim for object and entity types, preserve whitespace for strings
    const rawContent =
      dataType === FlowDataType.String
        ? decodedData
        : typeof decodedData === 'string'
          ? decodedData.trim()
          : String(decodedData);

    try {
      switch (dataType) {
        case FlowDataType.Object:
          this.parseObject(rawContent);
          break;

        case FlowDataType.Entity:
          this.parseEntity(rawContent);
          break;

        case FlowDataType.String:
          this.parseString(rawContent);
          break;
      }

      // Only set ready if no errors occurred and not already in error state
      if (!this._error) {
        this._isParsed = true;
        this.ready = true;

        this.emit(FlowDataEvents.PARSED, this.data);
        this.emit(FlowDataEvents.READY, this);
      }
    } catch (error) {
      this._setError(
        FlowErrorUtils.createError(
          FlowError.UNEXPECTED_PARSING_ERROR,
          error instanceof Error ? error.toString() : String(error),
        ).message,
      );
    }
  }

  /**
   * Set error state and message
   */
  private _setError(message: string): void {
    this._error = true;
    this.error_msg = message;
    this._isParsed = true; // Mark as processed but not ready

    const elementType = this.attributes['element-type'] || this.xmlTagName;
    const errorEvent = FlowErrorUtils.createErrorEvent(FlowError.JSON_PARSING_FAILED, message, this);
    this.emit(FlowDataEvents.ERROR, errorEvent);
    this.emit(FlowDataEvents.LOG_VERBOSE, `[${this.index}] 🔸 FlowData(${elementType}): parse error - ${message}`);
  }

  /**
   * Public method to set error state (for partial merging)
   */
  public setError(message: string): void {
    this._setError(message);
  }

  /**
   * Mark this FlowData as ready (for stream consolidation).
   * Sets the ready flag and emits the READY event.
   */
  public markReady(): void {
    if (this._ready) return;
    this._ready = true;
    this._isParsed = true;
    this.emit(FlowDataEvents.READY, this);
  }

  /**
   * Append content to this FlowData (for stream consolidation).
   * Unlike parseChunk, this works regardless of ready state.
   * Emits CHUNK event to notify subscribers of content update.
   *
   * @param content - Content string to append
   */
  public appendContent(content: string): void {
    if (this.dataType === FlowDataType.String) {
      if (typeof this.data === 'string') {
        this.data = (this.data + content) as any as T;
      } else if (typeof this.rawData === 'string') {
        this.rawData = this.rawData + content;
        this.data = this.rawData as T;
      } else {
        this.data = content as any as T;
      }
    }
    // Also update rawData for consistency
    if (typeof this.rawData === 'string') {
      this.rawData = this.rawData + content;
    }

    // Emit chunk event to notify subscribers of content update
    const chunkData: FlowDataChunk = {
      delta: content,
      totalContent: this.content,
    };
    this.emit(FlowDataEvents.CHUNK, chunkData);
  }

  /**
   * Get ready state - true when end tag matched and no more processing expected
   */
  get ready(): boolean {
    return this._ready;
  }

  set ready(value: boolean) {
    this._ready = value;
  }

  /**
   * Get error state - true when parsing failed
   */
  get error(): boolean {
    return this._error;
  }
  get lastChunk(): string {
    return this.last_chunk;
  }
  get lastChunkLength(): number {
    return this.last_chunk.length;
  }
  /**
   * Computed property: dataType comes from 'data-type' attribute, defaults to string if missing
   */
  get dataType(): FlowDataType | null {
    const dataTypeAttr = this.attributes['data-type'];

    // Default to string if data-type is missing
    const effectiveDataType = dataTypeAttr || 'string';

    // Map valid data-type values to enum
    if (effectiveDataType === 'json' || effectiveDataType === 'object') {
      return FlowDataType.Object;
    }
    if (effectiveDataType === 'entity') {
      return FlowDataType.Entity;
    }
    if (effectiveDataType === 'text' || effectiveDataType === 'string') {
      return FlowDataType.String;
    }

    // Unknown data-type value, default to string
    return FlowDataType.String;
  }

  set dataType(dataType: FlowDataType) {
    this.attributes['data-type'] = dataType;
  }

  /**
   * Full tag name as it appears in XML (e.g., "flow-text")
   * Use this for XML processing and matching end tags
   */
  get fullTagName(): string {
    return this.xmlTagName;
  }

  /**
   * Element type with prefix stripped (e.g., "flow-text" -> "text")
   * Returns the semantic element type for application logic
   * Logs a warning if the type is not in the FlowElementType enum
   */
  get elementType(): FlowElementType {
    // Normalize by stripping prefix if present
    const normalized = normalizeElementType(this.xmlTagName);

    // Validate against enum and return UNKNOWN if invalid
    if (!isFlowElementType(normalized)) {
      console.warn(`[FlowData] Unknown element type: "${normalized}" (from tagName: "${this.xmlTagName}")`);
    }

    return normalized as FlowElementType;
  }

  /**
   * Group ID for tracking related FlowData objects across multiple elements
   * Used by StreamProcessor to merge multi-element operations (e.g., streaming command outputs)
   * Server-only: Client should never set this, only read from server responses
   */
  get groupId(): string | null {
    return this.attributes['group-id'] || null;
  }

  /**
   * Channel identifier for distinguishing different data streams within the same group
   * Examples: "stdout", "stderr"
   * Elements without channel are standalone (not tracked by streaming processor)
   */
  get channel(): string | null {
    return this.attributes['channel'] || null;
  }

  /**
   * Whether this is the final element in a sequence (used for partials and streaming)
   * Returns true if the 'final' attribute is set to 'true'
   */
  get isFinal(): boolean {
    return this.attributes[FlowDataAttribute.FINAL] === 'true';
  }

  /**
   * Get the parsed data as JSON object (only valid when dataType is Object)
   */
  getJsonData(): T {
    if (this.dataType !== FlowDataType.Object) {
      throw new Error(`Cannot get JSON data for event of type ${this.dataType}`);
    }
    return typeof this.data === 'string' ? JSON.parse(this.data) : this.data;
  }

  /**
   * Get the data as text string (only valid when dataType is String)
   */
  getTextData(): string {
    if (this.dataType !== FlowDataType.String) {
      throw new Error(`Cannot get text data for event of type ${this.dataType}`);
    }
    return String(this.data);
  }

  /**
   * Get the data as entity object (only valid when dataType is Entity)
   */
  getEntityData(): T {
    if (this.dataType !== FlowDataType.Entity) {
      throw new Error(`Cannot get entity data for event of type ${this.dataType}`);
    }
    return this.data;
  }
  get contentLength(): number {
    if (typeof this.data === 'object' && this.data !== null && 'content' in this.data) {
      return (this.data as any).content?.length || 0;
    }
    if (typeof this.data === 'string') {
      return this.data.length;
    }
    if (this.data && typeof this.data === 'object' && 'length' in this.data) {
      return (this.data as any).length || 0;
    }
    return 0;
  }
  get content(): string {
    switch (this.dataType) {
      case FlowDataType.String:
        // During streaming, data may not be set yet but rawData accumulates via parseChunk()
        // Fall back to rawData for progressive content access
        if (this.data) {
          return this.data as string;
        }
        // Return rawData if available (streaming scenario)
        if (typeof this.rawData === 'string') {
          return this.rawData;
        }
        return '';
      case FlowDataType.Object:
        return JSON.stringify(this.data);
      case FlowDataType.Entity:
        return JSON.stringify(this.data);
      default:
        return '*no content*';
    }
  }
  /**
   * Reconstructs the outer XML representation of this FlowData element
   * Format: <flow-{tagName} attr1="val1" attr2="val2">{rawData}</flow-{tagName}>
   */
  get outerXML(): string {
    const attrs = Object.entries(this.attributes)
      .map(([key, value]) => `${key}="${value}"`)
      .join(' ');
    const attrsString = attrs ? ` ${attrs}` : '';
    return `<flow-${this.xmlTagName}${attrsString}>${this.rawData}</flow-${this.xmlTagName}>`;
  }

  /**
   * Nice string representation of the FlowData
   * Format: [index] type: "summary..." (length)
   */
  toString(): string {
    const contentLength = this.contentLength;
    const lengthInfo = contentLength > 0 ? ` (${contentLength}ch)` : '';
    const readyMarker = this.ready ? ' ✓' : '⏳';
    const errorMarker = this.error ? ' ❌' : '';
    const sourceInfo = `[${this.source}]`;
    const preview = this.content.slice(0, this.stringPreviewLength);

    return `FlowData ▤ ${sourceInfo} [${this.index}] ${this.xmlTagName} (${this.dataType},${lengthInfo}) : ${preview} -- ${readyMarker}${errorMarker}`;
  }
  toLog(): string {
    const contentLength = this.contentLength;
    const lengthInfo = contentLength > 0 ? ` (${contentLength}ch)` : '';
    const readyMarker = this.ready ? ' ✓' : '⏳';
    const errorMarker = this.error ? ' ❌' : '';
    const sourceInfo = `[${this.source}]`;
    const preview = this.content.slice(0, this.stringPreviewLength);

    return ` ▤ ${sourceInfo} (${this.dataType},${lengthInfo}) : ${preview} -- ${readyMarker}${errorMarker}`;
  }

  /**
   * Create a FlowData instance from a JSON object (for JSONL reader).
   * Maps backend serialization format to frontend FlowData.
   *
   * @param data - JSON object with flow_value, attributes, etc.
   * @returns FlowData instance
   */
  static fromJSON(data: Record<string, unknown>): FlowData {
    const attributes = (data.attributes as Record<string, string>) || {};
    const elementType = attributes['element-type'] || (data.element_type as string) || 'unknown';
    const content = (data.flow_value as string) || (data.content as string) || '';

    // Build attributes from JSON data
    const finalAttributes: Record<string, string> = {
      ...attributes,
      'element-type': elementType,
    };

    // Add index if present
    if (data.index !== undefined && (typeof data.index === 'number' || typeof data.index === 'string')) {
      finalAttributes['i'] = String(data.index);
    }

    // Add timestamp if present
    if (data.created_time) {
      finalAttributes['t'] = data.created_time as string;
    }

    // Add data-type if present
    if (data.data_type || attributes['data-type']) {
      finalAttributes['data-type'] = attributes['data-type'] || (data.data_type as string);
    } else {
      // Default to string for text content
      finalAttributes['data-type'] = 'string';
    }

    // Add warning/error if present in data
    if (data.warning && typeof data.warning === 'string') {
      finalAttributes[FlowDataAttribute.WARNING] = data.warning;
    }
    if (data.error && typeof data.error === 'string') {
      finalAttributes[FlowDataAttribute.ERROR] = data.error;
    }

    const flowData = new FlowData(elementType, content, finalAttributes);

    // Keep FlowData in non-ready state to allow consolidation via parseChunk
    // markReady() will be called when consolidation is complete
    flowData.ready = false;

    return flowData;
  }
}

// Type aliases for common use cases
export type StringFlowData = FlowData<{ content: string }>;
export type ObjectFlowData<T extends object = any> = FlowData<T>;
export type EntityFlowData<T = any> = FlowData<T>;

// Backward compatibility alias
