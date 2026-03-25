import { AgentHook } from '../entities/agent-hook';
import { FlowData } from '../flow_processing/flow-data';
import { FlowDataStream } from '../flow_processing/flow-data-stream';

/**
 * SnifferHook wraps the AgentHook sniffer entity and exposes named
 * FlowDataStream instances.  Consumers subscribe to the stream they
 * care about (e.g. `taskStream`) using standard hooks.
 *
 * Routing happens by listening to the `flow_data` event emitted by
 * `APIEntity.handleFlowData()` — no modifications to AgentHook needed.
 */
export class SnifferHook {
  /** The underlying AgentHook entity (still used by useHooksSniffer etc.) */
  readonly entity: AgentHook;

  /** Stream of task-related MCP events */
  readonly taskStream: FlowDataStream;

  private _unsubscribe: (() => void) | null = null;

  constructor(entity: AgentHook) {
    this.entity = entity;
    this.taskStream = new FlowDataStream({ name: 'tasks' });

    this._unsubscribe = this.entity.on('flow_data', (fd: FlowData) => {
      this._route(fd);
    });
  }

  private _route(fd: FlowData): void {
    const attrs = fd.attributes;
    if (attrs?.webhook_type !== 'mcp_webhook') return;

    const elementType = attrs['element-type'] ?? '';
    if (elementType.startsWith('task')) {
      this.taskStream.append(fd);
    }
  }

  dispose(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }
}
