/**
 * FlowDataStreamReader - Read FlowData from JSONL content (for testing)
 */
import { FlowData } from './flow-data';
import { FlowDataStream } from './flow-data-stream';

/**
 * Read FlowData from JSONL content.
 * Useful for testing and replaying recorded FlowData streams.
 */
export class FlowDataStreamReader {
  constructor(private jsonlContent: string) {}

  /**
   * Create a reader from JSONL content string
   */
  static fromContent(content: string): FlowDataStreamReader {
    return new FlowDataStreamReader(content);
  }

  /**
   * Iterate over FlowData items in the JSONL content
   */
  *[Symbol.iterator](): Iterator<FlowData> {
    const lines = this.jsonlContent.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      const data = JSON.parse(line);
      yield FlowData.fromJSON(data);
    }
  }

  /**
   * Read all FlowData items into an array
   */
  readAll(): FlowData[] {
    return [...this];
  }

  /**
   * Create a FlowDataStream from the JSONL content.
   * Uses ingest() for group consolidation.
   *
   * @param name - Optional name for the stream
   * @returns FlowDataStream with consolidated items
   */
  intoStream(name?: string): FlowDataStream {
    const stream = new FlowDataStream(name || 'reader-stream');
    for (const item of this) {
      stream.ingest(item);
    }
    stream.closeOpenGroups();
    return stream;
  }

  /**
   * Get the number of raw lines in the JSONL content
   */
  get lineCount(): number {
    return this.jsonlContent.split('\n').filter((l) => l.trim()).length;
  }
}
