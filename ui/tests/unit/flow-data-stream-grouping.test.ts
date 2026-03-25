import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FlowDataStream } from '@sdk/flow_processing/flow-data-stream';
import { FlowDataStreamReader } from '@sdk/flow_processing/flow-data-stream-reader';
import { FlowData } from '@sdk/flow_processing/flow-data';
import { FlowElementTypes } from '@sdk/flow_processing/flow-element-types';

/**
 * Tests for FlowDataStream group consolidation.
 *
 * The grouping feature solves the problem where claude_code_agentic_worker.py
 * yields individual FlowData for each streaming delta, resulting in many separate
 * cards instead of consolidated ones (e.g., 19 separate "Reasoning" cards instead of 1).
 *
 * Flow:
 *   Worker yields raw FlowData (NO group-id)
 *   → FlowDataStream.ingest()
 *   → Generates group-id + consolidates same-type items
 *   → Emits FlowData WITH group-id
 */
describe('FlowDataStream Grouping', () => {
  describe('FlowDataStreamReader', () => {
    it('should read JSONL content and create FlowData items', () => {
      const jsonlPath = join(__dirname, 'resources', 'grouping.jsonl');
      const content = readFileSync(jsonlPath, 'utf-8');
      const reader = FlowDataStreamReader.fromContent(content);

      const items = reader.readAll();

      // Raw JSONL has 6 items (3 reasoning, 2 chat, 1 status) - no group-id
      expect(items).toHaveLength(6);
      expect(items[0].elementType).toBe(FlowElementTypes.REASONING);
      expect(items[0].groupId).toBeNull(); // Raw items have no group-id
      expect(items[3].elementType).toBe(FlowElementTypes.CHAT);
      expect(items[5].elementType).toBe(FlowElementTypes.STATUS);
    });

    it('should report correct line count', () => {
      const jsonlPath = join(__dirname, 'resources', 'grouping.jsonl');
      const content = readFileSync(jsonlPath, 'utf-8');
      const reader = FlowDataStreamReader.fromContent(content);

      expect(reader.lineCount).toBe(6);
    });
  });

  describe('FlowDataStream.ingest() - raw processing mode', () => {
    it('should consolidate fragmented reasoning into single item with generated group-id', () => {
      const jsonlPath = join(__dirname, 'resources', 'grouping.jsonl');
      const content = readFileSync(jsonlPath, 'utf-8');
      const reader = FlowDataStreamReader.fromContent(content);
      const stream = reader.intoStream();

      const reasoningItems = stream.items.filter((fd) => fd.elementType === FlowElementTypes.REASONING);

      expect(reasoningItems).toHaveLength(1);
      expect(reasoningItems[0].content).toBe('Let me think about this problem.');
      expect(reasoningItems[0].groupId).not.toBeNull(); // Group-id was generated
      expect(reasoningItems[0].ready).toBe(true);
    });

    it('should consolidate fragmented chat into single item with generated group-id', () => {
      const jsonlPath = join(__dirname, 'resources', 'grouping.jsonl');
      const content = readFileSync(jsonlPath, 'utf-8');
      const reader = FlowDataStreamReader.fromContent(content);
      const stream = reader.intoStream();

      const chatItems = stream.items.filter((fd) => fd.elementType === FlowElementTypes.CHAT);

      expect(chatItems).toHaveLength(1);
      expect(chatItems[0].content).toBe('The answer is 4.');
      expect(chatItems[0].groupId).not.toBeNull(); // Group-id was generated
      expect(chatItems[0].ready).toBe(true);
    });

    it('should preserve non-streamable items without group-id', () => {
      const jsonlPath = join(__dirname, 'resources', 'grouping.jsonl');
      const content = readFileSync(jsonlPath, 'utf-8');
      const reader = FlowDataStreamReader.fromContent(content);
      const stream = reader.intoStream();

      const statusItems = stream.items.filter((fd) => fd.elementType === FlowElementTypes.STATUS);

      expect(statusItems).toHaveLength(1);
      expect(statusItems[0].content).toBe('complete');
      // Status is non-streamable, so no group-id assigned
      expect(statusItems[0].groupId).toBeNull();
    });

    it('should have correct total item count after consolidation', () => {
      const jsonlPath = join(__dirname, 'resources', 'grouping.jsonl');
      const content = readFileSync(jsonlPath, 'utf-8');
      const reader = FlowDataStreamReader.fromContent(content);
      const stream = reader.intoStream();

      // 1 reasoning + 1 chat + 1 status = 3 items (not 6 raw items)
      expect(stream.items).toHaveLength(3);
    });

    it('should assign different group-ids to different groups', () => {
      const jsonlPath = join(__dirname, 'resources', 'grouping.jsonl');
      const content = readFileSync(jsonlPath, 'utf-8');
      const reader = FlowDataStreamReader.fromContent(content);
      const stream = reader.intoStream();

      const reasoningItems = stream.items.filter((fd) => fd.elementType === FlowElementTypes.REASONING);
      const chatItems = stream.items.filter((fd) => fd.elementType === FlowElementTypes.CHAT);

      expect(reasoningItems[0].groupId).not.toBe(chatItems[0].groupId);
    });
  });

  describe('FlowDataStream.ingest() - programmatic raw processing', () => {
    it('should return FlowData for first item of new group (with generated group-id)', () => {
      const stream = new FlowDataStream('test');
      const item = new FlowData(FlowElementTypes.REASONING, 'Hello', {
        i: '0',
        t: new Date().toISOString(),
        'data-type': 'string',
      });

      const result = stream.ingest(item);

      expect(result).toBe(item);
      expect(stream.items).toHaveLength(1);
      expect(item.groupId).not.toBeNull(); // Group-id was generated
    });

    it('should return null for consolidated chunks (same type)', () => {
      const stream = new FlowDataStream('test');

      const item1 = new FlowData(FlowElementTypes.REASONING, 'Hello', {
        i: '0',
        t: new Date().toISOString(),
        'data-type': 'string',
      });
      stream.ingest(item1);

      const item2 = new FlowData(FlowElementTypes.REASONING, ' World', {
        i: '1',
        t: new Date().toISOString(),
        'data-type': 'string',
      });
      const result = stream.ingest(item2);

      expect(result).toBeNull();
      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('Hello World');
    });

    it('should start new group when element type changes', () => {
      const stream = new FlowDataStream('test');

      const reasoning = new FlowData(FlowElementTypes.REASONING, 'Thinking...', {
        i: '0',
        t: new Date().toISOString(),
        'data-type': 'string',
      });
      stream.ingest(reasoning);

      const chat = new FlowData(FlowElementTypes.CHAT, 'Here is the answer', {
        i: '1',
        t: new Date().toISOString(),
        'data-type': 'string',
      });
      const result = stream.ingest(chat);

      expect(result).toBe(chat);
      expect(stream.items).toHaveLength(2);
      expect(reasoning.ready).toBe(true); // Previous group closed
      expect(reasoning.groupId).not.toBe(chat.groupId); // Different groups
    });

    it('should add non-streamable types directly without grouping', () => {
      const stream = new FlowDataStream('test');

      const statusItem = new FlowData(FlowElementTypes.STATUS, 'running', {
        i: '0',
        t: new Date().toISOString(),
        'data-type': 'string',
      });
      const result = stream.ingest(statusItem);

      expect(result).toBe(statusItem);
      expect(stream.items).toHaveLength(1);
      expect(statusItem.groupId).toBeNull(); // Non-streamable, no group
    });

    it('should handle multiple groups sequentially', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Group 1 - reasoning (3 chunks)
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'Think', {
          i: '0',
          t: new Date(baseTime.getTime()).toISOString(),
          'data-type': 'string',
        }),
      );
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'ing', {
          i: '1',
          t: new Date(baseTime.getTime() + 100).toISOString(),
          'data-type': 'string',
        }),
      );
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, '...', {
          i: '2',
          t: new Date(baseTime.getTime() + 200).toISOString(),
          'data-type': 'string',
        }),
      );

      // Group 2 - chat (2 chunks)
      stream.ingest(
        new FlowData(FlowElementTypes.CHAT, 'Answer', {
          i: '3',
          t: new Date(baseTime.getTime() + 1000).toISOString(),
          'data-type': 'string',
        }),
      );
      stream.ingest(
        new FlowData(FlowElementTypes.CHAT, ' is 42', {
          i: '4',
          t: new Date(baseTime.getTime() + 1100).toISOString(),
          'data-type': 'string',
        }),
      );

      // Close open groups
      stream.closeOpenGroups();

      expect(stream.items).toHaveLength(2);
      expect(stream.items[0].content).toBe('Thinking...');
      expect(stream.items[0].ready).toBe(true);
      expect(stream.items[1].content).toBe('Answer is 42');
      expect(stream.items[1].ready).toBe(true);
    });
  });

  describe('FlowDataStream.ingest() - complete marker handling', () => {
    it('should skip complete marker if streaming group exists for same type', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Simulate streaming deltas first
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'Hello ', {
          i: '0',
          t: new Date(baseTime.getTime()).toISOString(),
          'data-type': 'string',
        }),
      );
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'World', {
          i: '1',
          t: new Date(baseTime.getTime() + 100).toISOString(),
          'data-type': 'string',
        }),
      );

      // Now complete message arrives (backend sends full content again)
      const completeItem = new FlowData(FlowElementTypes.REASONING, 'Hello World', {
        i: '2',
        t: new Date(baseTime.getTime() + 1000).toISOString(),
        'data-type': 'string',
        complete: 'true',
      });
      const result = stream.ingest(completeItem);

      // Complete marker should close group without duplicating content
      expect(result).toBeNull();
      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('Hello World'); // NOT 'Hello WorldHello World'
      expect(stream.items[0].ready).toBe(true);
    });

    it('should add complete item as new if no existing group', () => {
      const stream = new FlowDataStream('test');

      // Non-streaming scenario: complete message arrives without prior deltas
      const completeItem = new FlowData(FlowElementTypes.REASONING, 'Complete content', {
        i: '0',
        t: new Date().toISOString(),
        'data-type': 'string',
        complete: 'true',
      });
      const result = stream.ingest(completeItem);

      // Should be added as a new item
      expect(result).toBe(completeItem);
      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('Complete content');
    });

    it('should add complete item if existing group is different type', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Start with reasoning
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'Thinking...', {
          i: '0',
          t: new Date(baseTime.getTime()).toISOString(),
          'data-type': 'string',
        }),
      );

      // Complete marker for CHAT (different type)
      const completeChat = new FlowData(FlowElementTypes.CHAT, 'Chat response', {
        i: '1',
        t: new Date(baseTime.getTime() + 1000).toISOString(),
        'data-type': 'string',
        complete: 'true',
      });
      const result = stream.ingest(completeChat);

      // Should close reasoning group and add chat as new item
      expect(result).toBe(completeChat);
      expect(stream.items).toHaveLength(2);
      expect(stream.items[0].content).toBe('Thinking...');
      expect(stream.items[0].ready).toBe(true);
      expect(stream.items[1].content).toBe('Chat response');
    });
  });

  describe('FlowDataStream.ingest() - with group-id mode (from backend)', () => {
    it('should consolidate items with same group-id', () => {
      const stream = new FlowDataStream('test');

      const item1 = new FlowData(FlowElementTypes.REASONING, 'Hello', {
        i: '0',
        t: new Date().toISOString(),
        'group-id': 'backend-g1',
        'data-type': 'string',
      });
      stream.ingest(item1);

      const item2 = new FlowData(FlowElementTypes.REASONING, ' World', {
        i: '1',
        t: new Date().toISOString(),
        'group-id': 'backend-g1',
        'data-type': 'string',
      });
      stream.ingest(item2);

      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('Hello World');
    });

    it('should handle final marker to close group', () => {
      const stream = new FlowDataStream('test');

      const item = new FlowData(FlowElementTypes.REASONING, 'Content', {
        i: '0',
        t: new Date().toISOString(),
        'group-id': 'backend-g1',
        'data-type': 'string',
      });
      stream.ingest(item);

      const finalItem = new FlowData(FlowElementTypes.REASONING, '', {
        i: '1',
        t: new Date().toISOString(),
        'group-id': 'backend-g1',
        'data-type': 'string',
        final: 'true',
      });
      const result = stream.ingest(finalItem);

      expect(result).toBeNull();
      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].ready).toBe(true);
    });

    it('should replace streaming content with complete marker content (with group-id)', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Simulate streaming deltas with group-id (from backend)
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'Partial ', {
          i: '0',
          t: new Date(baseTime.getTime()).toISOString(),
          'group-id': 'backend-g1',
          'data-type': 'string',
        }),
      );
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'content', {
          i: '1',
          t: new Date(baseTime.getTime() + 100).toISOString(),
          'group-id': 'backend-g1',
          'data-type': 'string',
        }),
      );

      // Now complete message arrives with full content
      const completeItem = new FlowData(FlowElementTypes.REASONING, 'Full authoritative content', {
        i: '2',
        t: new Date(baseTime.getTime() + 1000).toISOString(),
        'group-id': 'backend-g1',
        'data-type': 'string',
        complete: 'true',
      });
      const result = stream.ingest(completeItem);

      // Complete marker should replace content and close group
      expect(result).toBeNull();
      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('Full authoritative content'); // Replaced, not appended
      expect(stream.items[0].ready).toBe(true);
    });

    it('should handle complete marker with no prior deltas (non-streaming message)', () => {
      const stream = new FlowDataStream('test');

      // Complete message arrives without any prior streaming deltas
      const completeItem = new FlowData(FlowElementTypes.CHAT, 'Direct response without streaming', {
        i: '0',
        t: new Date().toISOString(),
        'group-id': 'backend-g1',
        'data-type': 'string',
        complete: 'true',
      });
      const result = stream.ingest(completeItem);

      // Orphan complete messages are now surfaced as new items to handle
      // non-streaming backend responses that arrive as a single complete message
      expect(result).toBeNull();
      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('Direct response without streaming');
      expect(stream.items[0].ready).toBe(true);
    });

    it('should handle complete marker for different group-id than open group', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Start group 1 - use fromJSON to get non-ready state
      const g1Item = FlowData.fromJSON({
        flow_value: 'Group 1 content',
        attributes: {
          'element-type': FlowElementTypes.REASONING,
          'data-type': 'string',
          'group-id': 'backend-g1',
          i: '0',
          t: new Date(baseTime.getTime()).toISOString(),
        },
      });
      stream.ingest(g1Item);

      // Complete marker for different group (g2)
      const completeG2 = FlowData.fromJSON({
        flow_value: 'Group 2 complete',
        attributes: {
          'element-type': FlowElementTypes.REASONING,
          'data-type': 'string',
          'group-id': 'backend-g2',
          i: '1',
          t: new Date(baseTime.getTime() + 1000).toISOString(),
          complete: 'true',
        },
      });
      const result = stream.ingest(completeG2);

      // g2 doesn't exist, so nothing to complete
      expect(result).toBeNull();
      // g1 should still be there, not marked ready (still streaming)
      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('Group 1 content');
      expect(stream.items[0].ready).toBe(false);
    });

    it('should handle multiple groups with interleaved complete markers', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Start reasoning group
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'Think', {
          i: '0',
          t: new Date(baseTime.getTime()).toISOString(),
          'group-id': 'reasoning-1',
          'data-type': 'string',
        }),
      );
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'ing...', {
          i: '1',
          t: new Date(baseTime.getTime() + 100).toISOString(),
          'group-id': 'reasoning-1',
          'data-type': 'string',
        }),
      );

      // Start chat group (different group-id)
      stream.ingest(
        new FlowData(FlowElementTypes.CHAT, 'Hello', {
          i: '2',
          t: new Date(baseTime.getTime() + 200).toISOString(),
          'group-id': 'chat-1',
          'data-type': 'string',
        }),
      );
      stream.ingest(
        new FlowData(FlowElementTypes.CHAT, ' there', {
          i: '3',
          t: new Date(baseTime.getTime() + 300).toISOString(),
          'group-id': 'chat-1',
          'data-type': 'string',
        }),
      );

      // Complete reasoning first
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'Full reasoning content here', {
          i: '4',
          t: new Date(baseTime.getTime() + 1000).toISOString(),
          'group-id': 'reasoning-1',
          'data-type': 'string',
          complete: 'true',
        }),
      );

      // Complete chat second
      stream.ingest(
        new FlowData(FlowElementTypes.CHAT, 'Hello there, how can I help?', {
          i: '5',
          t: new Date(baseTime.getTime() + 1100).toISOString(),
          'group-id': 'chat-1',
          'data-type': 'string',
          complete: 'true',
        }),
      );

      expect(stream.items).toHaveLength(2);
      expect(stream.items[0].elementType).toBe(FlowElementTypes.REASONING);
      expect(stream.items[0].content).toBe('Full reasoning content here');
      expect(stream.items[0].ready).toBe(true);
      expect(stream.items[1].elementType).toBe(FlowElementTypes.CHAT);
      expect(stream.items[1].content).toBe('Hello there, how can I help?');
      expect(stream.items[1].ready).toBe(true);
    });

    it('should emit CHUNK event when replacing content with complete marker', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Start streaming
      const firstItem = new FlowData(FlowElementTypes.REASONING, 'Partial', {
        i: '0',
        t: new Date(baseTime.getTime()).toISOString(),
        'group-id': 'backend-g1',
        'data-type': 'string',
      });
      stream.ingest(firstItem);

      // Track CHUNK events
      let chunkEventReceived = false;
      let receivedTotalContent = '';
      firstItem.on('chunk', (data: { delta: string; totalContent: string }) => {
        chunkEventReceived = true;
        receivedTotalContent = data.totalContent;
      });

      // Complete marker replaces content
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'Complete content', {
          i: '1',
          t: new Date(baseTime.getTime() + 1000).toISOString(),
          'group-id': 'backend-g1',
          'data-type': 'string',
          complete: 'true',
        }),
      );

      expect(chunkEventReceived).toBe(true);
      expect(receivedTotalContent).toBe('Complete content');
    });
  });

  describe('FlowDataStream.ingest() - real backend simulation', () => {
    /**
     * These tests simulate the actual data flow from claude_code_agentic_worker.py
     * to ensure our tests match production behavior.
     */

    it('should handle typical reasoning stream: deltas → complete (with group-id)', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');
      const groupId = 'uuid-from-backend-12345';

      // Backend sends streaming deltas
      const deltas = ['The user ', 'is asking ', 'me to say ', 'hello.'];
      deltas.forEach((delta, i) => {
        stream.ingest(
          new FlowData(FlowElementTypes.REASONING, delta, {
            i: String(i),
            t: new Date(baseTime.getTime() + i * 50).toISOString(),
            'group-id': groupId,
            'data-type': 'string',
          }),
        );
      });

      // Verify streaming content is consolidated
      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('The user is asking me to say hello.');

      // Backend sends complete message with full content
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'The user is asking me to say hello.', {
          i: '4',
          t: new Date(baseTime.getTime() + 1000).toISOString(),
          'group-id': groupId,
          'data-type': 'string',
          complete: 'true',
        }),
      );

      // Content should remain the same (replaced with identical full content)
      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('The user is asking me to say hello.');
      expect(stream.items[0].ready).toBe(true);
    });

    it('should handle typical chat stream: deltas → complete (with group-id)', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');
      const groupId = 'chat-uuid-67890';

      // Backend sends streaming deltas
      const deltas = ['Hello! ', 'How can ', 'I help ', 'you today?'];
      deltas.forEach((delta, i) => {
        stream.ingest(
          new FlowData(FlowElementTypes.CHAT, delta, {
            i: String(i),
            t: new Date(baseTime.getTime() + i * 50).toISOString(),
            'group-id': groupId,
            'data-type': 'string',
          }),
        );
      });

      // Backend sends complete message
      stream.ingest(
        new FlowData(FlowElementTypes.CHAT, 'Hello! How can I help you today?', {
          i: '4',
          t: new Date(baseTime.getTime() + 1000).toISOString(),
          'group-id': groupId,
          'data-type': 'string',
          complete: 'true',
        }),
      );

      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('Hello! How can I help you today?');
      expect(stream.items[0].ready).toBe(true);
    });

    it('should handle full conversation: reasoning → chat with complete markers', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Reasoning stream
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'Let me ', {
          i: '0',
          t: new Date(baseTime.getTime()).toISOString(),
          'group-id': 'reasoning-uuid',
          'data-type': 'string',
        }),
      );
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'think...', {
          i: '1',
          t: new Date(baseTime.getTime() + 50).toISOString(),
          'group-id': 'reasoning-uuid',
          'data-type': 'string',
        }),
      );
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'Let me think about this carefully.', {
          i: '2',
          t: new Date(baseTime.getTime() + 500).toISOString(),
          'group-id': 'reasoning-uuid',
          'data-type': 'string',
          complete: 'true',
        }),
      );

      // Chat stream (different group)
      stream.ingest(
        new FlowData(FlowElementTypes.CHAT, 'The answer ', {
          i: '3',
          t: new Date(baseTime.getTime() + 1000).toISOString(),
          'group-id': 'chat-uuid',
          'data-type': 'string',
        }),
      );
      stream.ingest(
        new FlowData(FlowElementTypes.CHAT, 'is 42.', {
          i: '4',
          t: new Date(baseTime.getTime() + 1050).toISOString(),
          'group-id': 'chat-uuid',
          'data-type': 'string',
        }),
      );
      stream.ingest(
        new FlowData(FlowElementTypes.CHAT, 'The answer is 42.', {
          i: '5',
          t: new Date(baseTime.getTime() + 1500).toISOString(),
          'group-id': 'chat-uuid',
          'data-type': 'string',
          complete: 'true',
        }),
      );

      expect(stream.items).toHaveLength(2);
      expect(stream.items[0].elementType).toBe(FlowElementTypes.REASONING);
      expect(stream.items[0].content).toBe('Let me think about this carefully.');
      expect(stream.items[0].ready).toBe(true);
      expect(stream.items[1].elementType).toBe(FlowElementTypes.CHAT);
      expect(stream.items[1].content).toBe('The answer is 42.');
      expect(stream.items[1].ready).toBe(true);
    });

    it('should handle incomplete stream (no complete marker) with closeOpenGroups()', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Backend sends deltas but connection drops before complete marker
      // Use fromJSON to get non-ready state
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Partial ',
          attributes: {
            'element-type': FlowElementTypes.REASONING,
            'data-type': 'string',
            'group-id': 'incomplete-group',
            i: '0',
            t: new Date(baseTime.getTime()).toISOString(),
          },
        }),
      );
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'content...',
          attributes: {
            'element-type': FlowElementTypes.REASONING,
            'data-type': 'string',
            'group-id': 'incomplete-group',
            i: '1',
            t: new Date(baseTime.getTime() + 50).toISOString(),
          },
        }),
      );

      // Stream ends without complete marker
      expect(stream.items[0].ready).toBe(false);

      // Cleanup on stream end
      stream.closeOpenGroups();

      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('Partial content...');
      expect(stream.items[0].ready).toBe(true); // Now ready after cleanup
    });
  });

  describe('FlowDataStream.ingest() - edge cases', () => {
    it('should handle empty content in complete marker', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Start with content
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'Some content', {
          i: '0',
          t: new Date(baseTime.getTime()).toISOString(),
          'group-id': 'g1',
          'data-type': 'string',
        }),
      );

      // Complete marker with empty content (edge case)
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, '', {
          i: '1',
          t: new Date(baseTime.getTime() + 1000).toISOString(),
          'group-id': 'g1',
          'data-type': 'string',
          complete: 'true',
        }),
      );

      // Content should be replaced with empty string
      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('');
      expect(stream.items[0].ready).toBe(true);
    });

    it('should handle duplicate complete markers for same group', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Start streaming
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'Content', {
          i: '0',
          t: new Date(baseTime.getTime()).toISOString(),
          'group-id': 'g1',
          'data-type': 'string',
        }),
      );

      // First complete marker
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'Final content', {
          i: '1',
          t: new Date(baseTime.getTime() + 1000).toISOString(),
          'group-id': 'g1',
          'data-type': 'string',
          complete: 'true',
        }),
      );

      // Duplicate complete marker (network retry scenario)
      stream.ingest(
        new FlowData(FlowElementTypes.REASONING, 'Final content again', {
          i: '2',
          t: new Date(baseTime.getTime() + 1100).toISOString(),
          'group-id': 'g1',
          'data-type': 'string',
          complete: 'true',
        }),
      );

      // Should handle gracefully - group already closed
      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('Final content'); // First complete wins
      expect(stream.items[0].ready).toBe(true);
    });

    it('should handle both complete and final attributes (final takes precedence)', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Streaming content',
          attributes: {
            'element-type': FlowElementTypes.REASONING,
            'data-type': 'string',
            'group-id': 'g1',
            i: '0',
            t: new Date(baseTime.getTime()).toISOString(),
          },
        }),
      );

      // Message with both complete and final - final is checked first
      // This means the group is closed but content is NOT replaced (final just closes)
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Full content',
          attributes: {
            'element-type': FlowElementTypes.REASONING,
            'data-type': 'string',
            'group-id': 'g1',
            i: '1',
            t: new Date(baseTime.getTime() + 1000).toISOString(),
            complete: 'true',
            final: 'true',
          },
        }),
      );

      expect(stream.items).toHaveLength(1);
      // Content stays as streamed (not replaced) because 'final' takes precedence
      expect(stream.items[0].content).toBe('Streaming content');
      expect(stream.items[0].ready).toBe(true);
    });

    it('should handle non-streamable types with group-id (pass through)', () => {
      const stream = new FlowDataStream('test');

      // STATUS is non-streamable, should pass through even with group-id
      const statusItem = new FlowData(FlowElementTypes.STATUS, 'running', {
        i: '0',
        t: new Date().toISOString(),
        'group-id': 'status-group',
        'data-type': 'string',
      });
      const result = stream.ingest(statusItem);

      expect(result).toBe(statusItem);
      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('running');
    });

    it('should ignore late-arriving data for already closed group (data after complete)', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Normal stream
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Hello ',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            'group-id': 'g1',
            i: '0',
            t: new Date(baseTime.getTime()).toISOString(),
          },
        }),
      );

      // Complete marker closes the group
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Hello World',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            'group-id': 'g1',
            i: '1',
            t: new Date(baseTime.getTime() + 1000).toISOString(),
            complete: 'true',
          },
        }),
      );

      expect(stream.items[0].content).toBe('Hello World');
      expect(stream.items[0].ready).toBe(true);

      // Late-arriving delta for same group (network delay, out-of-order delivery)
      stream.ingest(
        FlowData.fromJSON({
          flow_value: '!',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            'group-id': 'g1',
            i: '2',
            t: new Date(baseTime.getTime() + 500).toISOString(), // Earlier timestamp but arrived late
          },
        }),
      );

      // Late data should start a NEW group since g1 is already closed
      // This is expected behavior - we can't reopen closed groups
      expect(stream.items).toHaveLength(2);
      expect(stream.items[0].content).toBe('Hello World'); // Original unchanged
    });

    it('should handle data arriving after closeOpenGroups() (late data)', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Start streaming
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Partial',
          attributes: {
            'element-type': FlowElementTypes.REASONING,
            'data-type': 'string',
            'group-id': 'g1',
            i: '0',
            t: new Date(baseTime.getTime()).toISOString(),
          },
        }),
      );

      // Force close all groups (simulates stream end)
      stream.closeOpenGroups();

      expect(stream.items[0].ready).toBe(true);

      // Late-arriving data after stream was closed
      stream.ingest(
        FlowData.fromJSON({
          flow_value: ' content',
          attributes: {
            'element-type': FlowElementTypes.REASONING,
            'data-type': 'string',
            'group-id': 'g1',
            i: '1',
            t: new Date(baseTime.getTime() + 100).toISOString(),
          },
        }),
      );

      // Should create new group since g1 was closed
      expect(stream.items).toHaveLength(2);
      expect(stream.items[0].content).toBe('Partial');
      expect(stream.items[1].content).toBe(' content');
    });
  });

  describe('FlowDataStream.ingest() - concurrent streams', () => {
    it('should handle truly interleaved messages from multiple groups', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Interleaved pattern: g1, g2, g1, g2, g1-complete, g2-complete
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'R1-',
          attributes: {
            'element-type': FlowElementTypes.REASONING,
            'data-type': 'string',
            'group-id': 'reasoning-stream',
            i: '0',
            t: new Date(baseTime.getTime()).toISOString(),
          },
        }),
      );

      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'C1-',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            'group-id': 'chat-stream',
            i: '1',
            t: new Date(baseTime.getTime() + 10).toISOString(),
          },
        }),
      );

      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'R2-',
          attributes: {
            'element-type': FlowElementTypes.REASONING,
            'data-type': 'string',
            'group-id': 'reasoning-stream',
            i: '2',
            t: new Date(baseTime.getTime() + 20).toISOString(),
          },
        }),
      );

      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'C2-',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            'group-id': 'chat-stream',
            i: '3',
            t: new Date(baseTime.getTime() + 30).toISOString(),
          },
        }),
      );

      // Complete reasoning
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Full Reasoning Content',
          attributes: {
            'element-type': FlowElementTypes.REASONING,
            'data-type': 'string',
            'group-id': 'reasoning-stream',
            i: '4',
            t: new Date(baseTime.getTime() + 1000).toISOString(),
            complete: 'true',
          },
        }),
      );

      // Complete chat
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Full Chat Content',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            'group-id': 'chat-stream',
            i: '5',
            t: new Date(baseTime.getTime() + 1100).toISOString(),
            complete: 'true',
          },
        }),
      );

      expect(stream.items).toHaveLength(2);
      expect(stream.items[0].content).toBe('Full Reasoning Content');
      expect(stream.items[0].ready).toBe(true);
      expect(stream.items[1].content).toBe('Full Chat Content');
      expect(stream.items[1].ready).toBe(true);
    });

    it('should handle three concurrent groups', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Three groups streaming concurrently
      const groups = ['group-a', 'group-b', 'group-c'];
      const types = [FlowElementTypes.REASONING, FlowElementTypes.CHAT, FlowElementTypes.SHELL_OUTPUT];

      // Send initial data for all three
      groups.forEach((groupId, idx) => {
        stream.ingest(
          FlowData.fromJSON({
            flow_value: `${groupId}-part1`,
            attributes: {
              'element-type': types[idx],
              'data-type': 'string',
              'group-id': groupId,
              i: String(idx),
              t: new Date(baseTime.getTime() + idx * 10).toISOString(),
            },
          }),
        );
      });

      // All three should be open
      expect(stream.items).toHaveLength(3);

      // Send more data to middle group
      stream.ingest(
        FlowData.fromJSON({
          flow_value: '-part2',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            'group-id': 'group-b',
            i: '3',
            t: new Date(baseTime.getTime() + 100).toISOString(),
          },
        }),
      );

      // Complete all three in reverse order
      groups.reverse().forEach((groupId, idx) => {
        stream.ingest(
          FlowData.fromJSON({
            flow_value: `Final content for ${groupId}`,
            attributes: {
              'element-type': types[2 - idx],
              'data-type': 'string',
              'group-id': groupId,
              i: String(10 + idx),
              t: new Date(baseTime.getTime() + 2000 + idx * 100).toISOString(),
              complete: 'true',
            },
          }),
        );
      });

      expect(stream.items).toHaveLength(3);
      // All should be ready
      stream.items.forEach((item) => {
        expect(item.ready).toBe(true);
      });
    });

    it('should handle group reuse after complete (same group-id, new stream)', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // First conversation turn
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'First ',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            'group-id': 'reusable-id',
            i: '0',
            t: new Date(baseTime.getTime()).toISOString(),
          },
        }),
      );
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'First response complete',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            'group-id': 'reusable-id',
            i: '1',
            t: new Date(baseTime.getTime() + 1000).toISOString(),
            complete: 'true',
          },
        }),
      );

      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('First response complete');

      // Second conversation turn with SAME group-id (backend reuses IDs)
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Second ',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            'group-id': 'reusable-id',
            i: '2',
            t: new Date(baseTime.getTime() + 5000).toISOString(),
          },
        }),
      );
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Second response complete',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            'group-id': 'reusable-id',
            i: '3',
            t: new Date(baseTime.getTime() + 6000).toISOString(),
            complete: 'true',
          },
        }),
      );

      // Should have two separate items (group-id reused but first was closed)
      expect(stream.items).toHaveLength(2);
      expect(stream.items[0].content).toBe('First response complete');
      expect(stream.items[1].content).toBe('Second response complete');
    });
  });

  describe('FlowDataStream.ingest() - auto-close scenarios', () => {
    it('should auto-close group when type changes (raw mode without group-id)', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Raw mode: no group-id, type change triggers auto-close
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Thinking...',
          attributes: {
            'element-type': FlowElementTypes.REASONING,
            'data-type': 'string',
            i: '0',
            t: new Date(baseTime.getTime()).toISOString(),
          },
        }),
      );

      // Type change to CHAT auto-closes REASONING group
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Hello!',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            i: '1',
            t: new Date(baseTime.getTime() + 1000).toISOString(),
          },
        }),
      );

      expect(stream.items).toHaveLength(2);
      expect(stream.items[0].ready).toBe(true); // Auto-closed
      expect(stream.items[1].ready).toBe(false); // Still open
    });

    it('should auto-close group when non-streamable type arrives (raw mode)', () => {
      const stream = new FlowDataStream('test');
      const baseTime = new Date('2025-01-01T10:00:00Z');

      // Start with streamable type
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Streaming content',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            i: '0',
            t: new Date(baseTime.getTime()).toISOString(),
          },
        }),
      );

      // Non-streamable type arrives - should auto-close previous group
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'running',
          attributes: {
            'element-type': FlowElementTypes.STATUS,
            'data-type': 'string',
            i: '1',
            t: new Date(baseTime.getTime() + 1000).toISOString(),
          },
        }),
      );

      expect(stream.items).toHaveLength(2);
      expect(stream.items[0].ready).toBe(true); // Auto-closed by STATUS
      expect(stream.items[0].content).toBe('Streaming content');
    });

    it('should handle clear() resetting all state', () => {
      const stream = new FlowDataStream('test');

      // Add some items
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'Content',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            'group-id': 'g1',
            i: '0',
            t: new Date().toISOString(),
          },
        }),
      );

      expect(stream.items).toHaveLength(1);

      // Clear the stream
      stream.clear();

      expect(stream.items).toHaveLength(0);

      // New data should work normally
      stream.ingest(
        FlowData.fromJSON({
          flow_value: 'New content',
          attributes: {
            'element-type': FlowElementTypes.CHAT,
            'data-type': 'string',
            'group-id': 'g2',
            i: '0',
            t: new Date().toISOString(),
          },
        }),
      );

      expect(stream.items).toHaveLength(1);
      expect(stream.items[0].content).toBe('New content');
    });
  });

  describe('FlowData.fromJSON()', () => {
    it('should create FlowData from JSON with all fields', () => {
      const json = {
        flow_value: 'Test content',
        attributes: { 'element-type': 'reasoning', 'data-type': 'string' },
        index: 5,
        created_time: '2025-01-01T10:00:00.000Z',
      };

      const flowData = FlowData.fromJSON(json);

      expect(flowData.elementType).toBe('reasoning');
      expect(flowData.content).toBe('Test content');
      expect(flowData.index).toBe(5);
      expect(flowData.timestamp).toBe('2025-01-01T10:00:00.000Z');
    });

    it('should handle minimal JSON', () => {
      const json = {
        flow_value: 'Hello',
        attributes: { 'element-type': 'chat' },
      };

      const flowData = FlowData.fromJSON(json);

      expect(flowData.elementType).toBe('chat');
      expect(flowData.content).toBe('Hello');
    });
  });

  describe('FlowData.markReady()', () => {
    it('should set ready flag and emit READY event', () => {
      // Use fromJSON to get FlowData in non-ready state
      const flowData = FlowData.fromJSON({
        flow_value: 'test',
        attributes: {
          'element-type': FlowElementTypes.REASONING,
          'data-type': 'string',
          i: '0',
          t: new Date().toISOString(),
        },
      });

      expect(flowData.ready).toBe(false);

      let eventEmitted = false;
      flowData.on('ready', () => {
        eventEmitted = true;
      });

      flowData.markReady();

      expect(flowData.ready).toBe(true);
      expect(eventEmitted).toBe(true);
    });

    it('should be idempotent', () => {
      // Use fromJSON to get FlowData in non-ready state
      const flowData = FlowData.fromJSON({
        flow_value: 'test',
        attributes: {
          'element-type': FlowElementTypes.REASONING,
          'data-type': 'string',
          i: '0',
          t: new Date().toISOString(),
        },
      });

      let eventCount = 0;
      flowData.on('ready', () => {
        eventCount++;
      });

      flowData.markReady();
      flowData.markReady();
      flowData.markReady();

      expect(eventCount).toBe(1);
    });
  });
});
