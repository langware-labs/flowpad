/**
 * Helper class for composite key tracking of element-type + group-id + channel
 * Used to uniquely identify FlowData objects within the streaming processor
 */
export class GroupChannelKey {
  constructor(
    public readonly elementType: string,
    public readonly groupId: string,
    public readonly channel: string,
  ) {}

  /**
   * Convert to string key for Map storage
   */
  toString(): string {
    return `${this.elementType}::${this.groupId}::${this.channel}`;
  }

  /**
   * Parse a string key back to GroupChannelKey
   */
  static parse(key: string): GroupChannelKey | null {
    const parts = key.split('::');
    if (parts.length !== 3) return null;
    return new GroupChannelKey(parts[0], parts[1], parts[2]);
  }

  /**
   * Check if a map key belongs to a specific group
   */
  static belongsToGroup(key: string, groupId: string): boolean {
    const parts = key.split('::');
    return parts.length === 3 && parts[1] === groupId;
  }
}
