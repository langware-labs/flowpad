/**
 * Generic JSON file operations service.
 * Provides read/write operations for JSON files via ComputeNode.
 */

import type { ComputeNode } from '../entities/compute-node/compute-node';

/**
 * Service for reading and writing JSON files on a compute node.
 */
export class JsonFileService {
  constructor(private computeNode: ComputeNode) {}

  /**
   * Read a JSON file and return its parsed contents.
   * @param path - Absolute path to the JSON file
   * @returns Parsed JSON data
   */
  async readJson<T = unknown>(path: string): Promise<T> {
    return await this.computeNode.getJsonFile<T>(path);
  }

  /**
   * Write JSON data to a file.
   * @param path - Absolute path to the JSON file
   * @param data - JSON data to write
   */
  async writeJson(path: string, data: unknown): Promise<void> {
    await this.computeNode.saveJsonFile(path, data);
  }

  /**
   * Read a JSON file, modify it with a callback, and write it back.
   * @param path - Absolute path to the JSON file
   * @param modifier - Callback function that modifies the data
   * @returns The modified data
   */
  async modifyJson<T = unknown>(path: string, modifier: (data: T) => T | void): Promise<T> {
    const data = await this.readJson<T>(path);
    const modified = modifier(data);
    const result = modified !== undefined ? modified : data;
    await this.writeJson(path, result);
    return result;
  }
}

/**
 * Create a JsonFileService instance for a compute node.
 */
export function createJsonFileService(computeNode: ComputeNode): JsonFileService {
  return new JsonFileService(computeNode);
}
