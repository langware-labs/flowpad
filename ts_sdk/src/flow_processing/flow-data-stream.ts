import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import { FlowData } from './flow-data';
import { FlowElementType, FlowElementTypes, isStreamableElementType } from './flow-element-types';
import { FlowDataEvents, FlowEvents } from './flow-events';

export type SubstreamFilter =
  | FlowElementType[] // whitelist array
  | ((data: FlowData) => FlowData | null); // function filter

export class Substream {
  constructor(
    public readonly id: string,
    public readonly stream: FlowDataStream,
    public filter?: SubstreamFilter,
  ) {}

  toString(): string {
    const count = this.stream.items.length;
    return `${this.stream.name} (${count} items)`;
  }
}

export class FlowDataStream extends EventEmitter {
  public readonly id: string;
  public readonly name: string;

  private _ownItems: FlowData[] = [];
  private _substreams: Substream[] = [];
  private _parent: FlowDataStream | null = null;
  private _isComplete: boolean = false;
  private _renderCounter: number = 0;

  // Group consolidation tracking
  private _openGroups: Map<string, FlowData> = new Map();
  // Current group tracking for items without group-id (raw processing mode)
  private _currentGroupId: string | null = null;
  private _currentGroupType: string | null = null;
  // Recently seen stream chunk keys to dedupe duplicate WS/HTTP deliveries
  private _recentChunkKeys: Set<string> = new Set();
  private _recentChunkKeysQueue: string[] = [];

  /**
   * Creates a new FlowDataStream
   * @param nameOrConfig - Either a string name (id will be auto-generated) or a config object with id and/or name
   *
   * @example
   * // Auto-generated ID
   * new FlowDataStream('Flow Shell')
   *
   * // Explicit ID
   * new FlowDataStream({ id: 'flowShell', name: 'Flow Shell' })
   *
   * // Config with auto-generated ID
   * new FlowDataStream({ name: 'Flow Shell' })
   */
  constructor(nameOrConfig: string | { id?: string; name: string }) {
    super();
    if (typeof nameOrConfig === 'string') {
      this.id = uuid();
      this.name = nameOrConfig;
    } else {
      this.id = nameOrConfig.id || uuid();
      this.name = nameOrConfig.name;
    }

    // Customize console display - add a display property that DevTools will show
    Object.defineProperty(this, 'display', {
      get: () => this.toString(),
      enumerable: true,
      configurable: true,
    });
  }

  get parent(): FlowDataStream | null {
    return this._parent;
  }

  get lastSubstream(): FlowDataStream | null {
    return this._substreams.length > 0 ? this._substreams[this._substreams.length - 1].stream : null;
  }

  get substreams(): readonly FlowDataStream[] {
    return this._substreams.map((s) => s.stream);
  }

  get isPendingWrite(): boolean {
    if (this.items.length < 2) return false;
    const currentItem = this.items[this.items.length - 1];
    const previousItem = this.items[this.items.length - 2];
    if (!previousItem.ready) return false;
    if (currentItem.elementType === FlowElementTypes.WRITE && previousItem.elementType === FlowElementTypes.WRITE) {
      if (currentItem.attributes.path != previousItem.attributes.path) return true;
      else return false;
    }
    if (previousItem.elementType === FlowElementTypes.WRITE && currentItem.elementType !== FlowElementTypes.WRITE) {
      return true;
    }
    return false;
  }

  getPendingWriteContent(): { path?: string; rawDataContent?: string } {
    if (!this.isPendingWrite) {
      return { path: undefined, rawDataContent: undefined };
    }
    const previousItem = this.items[this.items.length - 2];
    const path = previousItem.attributes.path;
    const itemsWrite = [];
    for (let i = this.items.length - 2; i >= 0; i--) {
      const item = this.items[i];
      if (item.elementType === FlowElementTypes.WRITE && item.attributes.path === path) {
        itemsWrite.push(item);
      } else {
        break;
      }
    }

    const contentRawData = itemsWrite.reverse().reduce((acc, item) => acc + ((item.rawData as string) ?? ''), '');
    return { path: path, rawDataContent: contentRawData };
  }

  addSubstream(stream: FlowDataStream, filter?: SubstreamFilter): void {
    const substream = new Substream(stream.id, stream, filter);
    this._substreams.push(substream);
    stream._parent = this;

    stream.on('data', (items: FlowData[], source: FlowDataStream) => {
      this.emit('data', items, source);
    });

    stream.on('complete', (source: FlowDataStream) => {
      this.emit('complete', source);
    });
    this.emit('substream-added', stream);
  }

  removeSubstream(id: string): void {
    const index = this._substreams.findIndex((s) => s.id === id);
    if (index !== -1) {
      const substream = this._substreams[index];
      substream.stream._parent = null;
      substream.stream.removeAllListeners('data');
      substream.stream.removeAllListeners('complete');
      this._substreams.splice(index, 1);
    }
  }

  getSubstream(id: string): FlowDataStream | undefined {
    return this._substreams.find((s) => s.id === id)?.stream;
  }

  append(items: FlowData | FlowData[]): void {
    const newItems = Array.isArray(items) ? items : [items];
    this._ownItems.push(...newItems);
    this.emit('data', newItems, this);
  }

  /**
   * Ingest FlowData with group consolidation.
   *
   * Handles two modes:
   * 1. Items WITH group-id (from backend stream): consolidate by group-id
   * 2. Items WITHOUT group-id (raw processing): generate group-id, consolidate by element type
   *
   * @param item - FlowData item to ingest
   * @returns The FlowData if it's new, null if consolidated into existing group
   */
  ingest(item: FlowData): FlowData | null {
    const elementType = item.elementType;
    const groupId = item.groupId;

    if (elementType === FlowElementTypes.USER_MESSAGE) {
      const role = item.attributes.role ?? '';
      const existing = [...this._ownItems]
        .reverse()
        .find(
          (entry) =>
            entry.elementType === FlowElementTypes.USER_MESSAGE &&
            (entry.attributes.role ?? '') === role &&
            entry.content === item.content,
        );
      if (existing) {
        return null;
      }
    }

    // Mode 1: Item has group-id (from backend stream processor)
    if (groupId) {
      return this._ingestWithGroupId(item, groupId);
    }

    // Mode 2: Item has no group-id (raw processing, like JSONL reader)
    return this._ingestRaw(item, elementType);
  }

  /**
   * Ingest item that already has group-id (from backend stream)
   */
  private _ingestWithGroupId(item: FlowData, groupId: string): FlowData | null {
    // Debug: Log consolidation decisions
    const logPrefix = `[FlowDataStream:${this.name}] groupId=${groupId.slice(0, 8)}`;

    // Final marker = close group
    if (item.isFinal) {
      const tracked = this._openGroups.get(groupId);
      if (tracked) {
        tracked.markReady();
        this._openGroups.delete(groupId);
      }
      console.debug(`${logPrefix} FINAL marker - closing group, tracked=${!!tracked}`);
      return null;
    }

    // Handle complete="true" - replace content with authoritative full content
    // The backend sends BOTH streaming deltas AND a complete message with full content
    if (item.attributes['complete'] === 'true') {
      const tracked = this._openGroups.get(groupId);
      console.debug(
        `${logPrefix} COMPLETE message - tracked=${!!tracked}, itemsCount=${this._ownItems.length}, openGroups=${this._openGroups.size}`,
      );
      if (tracked) {
        // Replace streaming content with complete message's authoritative content
        tracked.data = item.content;
        tracked.rawData = item.content;
        // Emit CHUNK event to notify UI of content update
        tracked.emit(FlowDataEvents.CHUNK, {
          delta: '',
          totalContent: item.content,
        });
        tracked.markReady();
        this._openGroups.delete(groupId);
        console.debug(`${logPrefix} COMPLETE - updated tracked item, NOT adding to items`);
      } else {
        // Check if this group was already closed (item exists in _ownItems but not tracked)
        // This can happen if the same FlowData arrives via multiple paths (HTTP + WebSocket)
        const existingItem = this._ownItems.find((i) => i.groupId === groupId);
        if (existingItem) {
          // Group already processed - only update if not already ready (first complete wins)
          if (!existingItem.ready) {
            existingItem.data = item.content;
            existingItem.rawData = item.content;
            existingItem.markReady();
            console.debug(`${logPrefix} COMPLETE - found existing item, updated content, NOT adding duplicate`);
          } else {
            console.debug(`${logPrefix} COMPLETE - duplicate marker for already-closed group, ignoring`);
          }
        } else if (this._openGroups.size === 0) {
          // If we only receive a COMPLETE message (no prior stream chunks),
          // and there are no other active streaming groups, surface the content.
          // If there are open groups, this is likely a stray COMPLETE for a different
          // conversation and should be ignored.
          item.markReady();
          this._ownItems.push(item);
          this.emit('data', [item], this);
          console.debug(`${logPrefix} COMPLETE - added missing group as new item`);
        } else {
          console.debug(`${logPrefix} COMPLETE - no matching group and ${this._openGroups.size} open groups, ignoring`);
        }
      }
      return null;
    }

    // Non-streamable types pass through
    if (!isStreamableElementType(item.elementType)) {
      this._ownItems.push(item);
      this.emit('data', [item], this);
      console.debug(
        `${logPrefix} NON-STREAMABLE (${item.elementType}) - added to items, count=${this._ownItems.length}`,
      );
      return item;
    }

    // Existing group = consolidate
    if (this._openGroups.has(groupId)) {
      const tracked = this._openGroups.get(groupId)!;
      if (this._isDuplicateChunk(item, groupId)) {
        console.debug(`${logPrefix} DUPLICATE chunk - ignoring`);
        return null;
      }
      tracked.appendContent(item.content);
      console.debug(`${logPrefix} CONSOLIDATE - appending content, NOT adding to items`);
      return null;
    }

    // New group = add and track
    this._ownItems.push(item);
    this._openGroups.set(groupId, item);
    this.emit('data', [item], this);
    console.debug(`${logPrefix} NEW GROUP (${item.elementType}) - added to items, count=${this._ownItems.length}`);
    return item;
  }

  /**
   * Ingest raw item without group-id (generates group-id, consolidates by type)
   */
  private _ingestRaw(item: FlowData, elementType: string): FlowData | null {
    // Non-streamable types: close current group, pass through
    if (!isStreamableElementType(elementType)) {
      this._closeCurrentGroup();
      this._ownItems.push(item);
      this.emit('data', [item], this);
      return item;
    }

    // Handle complete="true" items: these mark the end of a streaming sequence
    // The backend sends BOTH streaming deltas AND a complete message with full content
    // Replace the streaming content with the complete content to ensure full data
    if (item.attributes['complete'] === 'true') {
      if (this._currentGroupId && this._currentGroupType === elementType) {
        // Group exists for this type - replace content with complete message and close
        const tracked = this._openGroups.get(this._currentGroupId)!;
        // Replace content with complete message's authoritative content
        tracked.data = item.content;
        tracked.rawData = item.content;
        // Emit CHUNK event to notify UI of content update
        tracked.emit(FlowDataEvents.CHUNK, {
          delta: '',
          totalContent: item.content,
        });
        this._closeCurrentGroup();
        return null;
      }
      // No existing group - this is a non-streaming complete message, add it
      this._ownItems.push(item);
      this.emit('data', [item], this);
      return item;
    }

    // Check if we should start new group or continue current
    if (this._shouldStartNewGroup(elementType)) {
      this._closeCurrentGroup();

      // Generate group-id for this item
      const newGroupId = this._generateGroupId();
      item.attributes['group-id'] = newGroupId;

      this._currentGroupId = newGroupId;
      this._currentGroupType = elementType;
      this._openGroups.set(newGroupId, item);
      this._ownItems.push(item);
      this.emit('data', [item], this);
      return item;
    } else {
      // Consolidate into current group
      const tracked = this._openGroups.get(this._currentGroupId!)!;
      if (this._isDuplicateChunk(item, this._currentGroupId!)) {
        return null;
      }
      tracked.appendContent(item.content);
      return null;
    }
  }

  private _shouldStartNewGroup(elementType: string): boolean {
    if (this._currentGroupId === null) return true;
    if (elementType !== this._currentGroupType) return true;
    return false;
  }

  private _closeCurrentGroup(): void {
    if (this._currentGroupId && this._openGroups.has(this._currentGroupId)) {
      const tracked = this._openGroups.get(this._currentGroupId)!;
      tracked.markReady();
      this._openGroups.delete(this._currentGroupId);
    }
    this._currentGroupId = null;
    this._currentGroupType = null;
  }

  private _generateGroupId(): string {
    return `g-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Close all open groups when stream is complete
   */
  closeOpenGroups(): void {
    this._closeCurrentGroup();
    for (const [, tracked] of this._openGroups) {
      tracked.markReady();
    }
    this._openGroups.clear();
  }

  clear(): void {
    this._ownItems = [];
    this._isComplete = false;
    this._substreams = [];
    this._openGroups.clear();
    this._currentGroupId = null;
    this._currentGroupType = null;
    this._recentChunkKeys.clear();
    this._recentChunkKeysQueue = [];
    this.emit('clear');
  }

  private _isDuplicateChunk(item: FlowData, groupId: string): boolean {
    const indexAttr = item.attributes?.i ?? '';
    const timestampAttr = item.attributes?.t ?? '';
    const hasIdentity = indexAttr !== '' || timestampAttr !== '';
    if (!hasIdentity) {
      return false;
    }
    const identity = indexAttr !== '' ? indexAttr : timestampAttr;
    const key = `${groupId}|${item.elementType}|${identity}|${item.content ?? ''}`;
    if (this._recentChunkKeys.has(key)) {
      return true;
    }
    this._recentChunkKeys.add(key);
    this._recentChunkKeysQueue.push(key);
    if (this._recentChunkKeysQueue.length > 200) {
      const oldest = this._recentChunkKeysQueue.shift();
      if (oldest) {
        this._recentChunkKeys.delete(oldest);
      }
    }
    return false;
  }

  get ownItems(): readonly FlowData[] {
    return [...this._ownItems];
  }
  get items(): readonly FlowData[] {
    const allItems: FlowData[] = [...this._ownItems];

    for (const substream of this._substreams) {
      const substreamItems = substream.stream.items;

      if (substream.filter) {
        allItems.push(...this._applyFilter(substreamItems, substream.filter));
      } else {
        allItems.push(...substreamItems);
      }
    }

    return allItems.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      return timeA - timeB;
    });
  }

  get isEmpty(): boolean {
    return this._ownItems.length === 0 && this._substreams.length === 0;
  }

  get count(): number {
    let total = this._ownItems.length;
    for (const substream of this._substreams) {
      const substreamItems = substream.stream.items;
      if (substream.filter) {
        total += this._applyFilter(substreamItems, substream.filter).length;
      } else {
        total += substreamItems.length;
      }
    }
    return total;
  }

  get isComplete(): boolean {
    return this._isComplete;
  }

  markComplete(): void {
    if (!this._isComplete) {
      this._isComplete = true;
      this.emit('complete', this);
    }
  }

  get renderCounter(): number {
    return this._renderCounter;
  }

  forceRender(): void {
    console.log(`[FlowDataStream] forceRender called on stream '${this.name}' (id: ${this.id})`, {
      oldCounter: this._renderCounter,
      newCounter: this._renderCounter + 1,
    });
    this._renderCounter++;
    this.emit(FlowEvents.RENDER);
    console.log(`[FlowDataStream] RENDER event emitted for stream '${this.name}'`);
  }

  toString(): string {
    const count = this.items.length;
    return `${this.name} (${count} items)`;
  }

  valueOf(): string {
    return this.toString();
  }

  [Symbol.toPrimitive](hint: 'string' | 'number' | 'default'): string {
    if (hint === 'string' || hint === 'default') {
      return this.toString();
    }
    return String(this.items.length);
  }

  filter(predicate: (fd: FlowData) => boolean): FlowData[] {
    return this.items.filter(predicate);
  }

  filterByTag(tag: FlowElementType): FlowData[] {
    return this.items.filter((fd) => fd.elementType === tag);
  }

  filterByTags(tags: FlowElementType[]): FlowData[] {
    const tagSet = new Set(tags);
    return this.items.filter((fd) => tagSet.has(fd.elementType));
  }

  find(predicate: (fd: FlowData) => boolean): FlowData | undefined {
    return this.items.find(predicate);
  }

  findByTag(tag: FlowElementType): FlowData | undefined {
    return this.items.find((fd) => fd.elementType === tag);
  }

  findLast(predicate: (fd: FlowData) => boolean): FlowData | undefined {
    const allItems = [...this.items];
    for (let i = allItems.length - 1; i >= 0; i--) {
      if (predicate(allItems[i])) {
        return allItems[i];
      }
    }
    return undefined;
  }

  findLastByTag(tag: FlowElementType): FlowData | undefined {
    return this.findLast((fd) => fd.elementType === tag);
  }

  forEach(callback: (fd: FlowData, index: number) => void): void {
    this.items.forEach(callback);
  }

  map<T>(callback: (fd: FlowData, index: number) => T): T[] {
    return this.items.map(callback);
  }

  static merge(...streams: FlowDataStream[]): FlowData[] {
    const allItems: FlowData[] = [];

    for (const stream of streams) {
      allItems.push(...stream.items);
    }

    return allItems.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime();
      const timeB = new Date(b.timestamp).getTime();
      return timeA - timeB;
    });
  }

  private _applyFilter(items: readonly FlowData[], filter: SubstreamFilter): FlowData[] {
    if (Array.isArray(filter)) {
      // Whitelist: only include matching types
      const whitelist = new Set(filter);
      return items.filter((item) => whitelist.has(item.elementType));
    } else {
      // Function: transform or filter (null = exclude)
      return items
        .map((item) => {
          try {
            return filter(item);
          } catch (error) {
            console.error('Error in substream filter function:', error);
            return null; // Filter out item on error
          }
        })
        .filter((item) => item !== null);
    }
  }
}
