import type { EventLayer, SnifferEvent } from './use-hooks-sniffer';

export interface LayerProcessor {
  name: EventLayer;
  process: (scopedEvents: SnifferEvent[]) => SnifferEvent[];
}

export const LAYER_COLORS: Record<EventLayer, string> = {
  debug: 'text-muted-foreground',
  info: 'text-cyan-500',
  raw_notifications: 'text-emerald-500',
  resource: 'text-green-500',
};

function makeInfoEvent(source: SnifferEvent, eventType: string, summary: string): SnifferEvent {
  return {
    ...source,
    id: `info-${source.id}`,
    event_type: eventType,
    layer: 'info',
    summary,
    source_event_id: source.id,
  };
}

const INFO_LAYER: LayerProcessor = {
  name: 'info',
  process(scopedEvents) {
    const infoEvents: SnifferEvent[] = [];

    for (const event of scopedEvents) {
      const hookData = event.hook_data;

      if (event.event_type === 'PreToolUse' && hookData?.tool_name === 'Task') {
        const desc = hookData.tool_input?.description || hookData.tool_input?.prompt || 'Task';
        infoEvents.push(makeInfoEvent(event, 'TaskStart', desc));
      } else if (event.event_type === 'PreToolUse' && hookData?.tool_name === 'Skill') {
        // Detect Skill tool usage and create a highlighted event
        const skillName = hookData.tool_input?.skill || 'unknown';
        const skillArgs = hookData.tool_input?.args || '';
        const summary = skillArgs ? `/${skillName} ${skillArgs}` : `/${skillName}`;
        infoEvents.push(makeInfoEvent(event, 'SkillUsed', summary));
      } else if (event.event_type === 'SessionStart') {
        infoEvents.push(makeInfoEvent(event, 'SessionStart', 'Session started'));
      } else if (event.event_type === 'SessionEnd') {
        infoEvents.push(makeInfoEvent(event, 'SessionEnd', 'Session ended'));
      } else if (event.event_type === 'Stop') {
        const reason = hookData?.raw_hook_data?.stop_reason || 'completed';
        infoEvents.push(makeInfoEvent(event, 'AgentComplete', reason));
      } else if (event.event_type === 'SubagentStart') {
        const agentType = hookData?.raw_hook_data?.agent_type || 'agent';
        infoEvents.push(makeInfoEvent(event, 'SubagentStart', `Subagent started: ${agentType}`));
      } else if (event.event_type === 'TaskCreated') {
        const subject = hookData?.raw_hook_data?.task_subject || 'task';
        infoEvents.push(makeInfoEvent(event, 'TaskCreated', `Created: ${subject}`));
      } else if (event.event_type === 'TaskCompleted') {
        const subject = hookData?.raw_hook_data?.task_subject || 'task';
        infoEvents.push(makeInfoEvent(event, 'TaskCompleted', `Completed: ${subject}`));
      } else if (event.event_type === 'PostToolUseFailure') {
        const toolName = hookData?.tool_name || 'tool';
        const error = hookData?.raw_hook_data?.error || 'failed';
        infoEvents.push(makeInfoEvent(event, 'PostToolUseFailure', `${toolName}: ${error}`));
      }
    }

    return infoEvents;
  },
};

function makeRawNotificationEvent(source: SnifferEvent, eventType: string, summary: string): SnifferEvent {
  return {
    ...source,
    id: `rn-${source.id}`,
    event_type: eventType,
    layer: 'raw_notifications',
    summary,
    source_event_id: source.id,
  };
}

const RAW_NOTIFICATIONS_LAYER: LayerProcessor = {
  name: 'raw_notifications',
  process(scopedEvents) {
    const notifications: SnifferEvent[] = [];

    for (const event of scopedEvents) {
      if (event.webhook_type !== 'transcript_entry') continue;

      const hookData = event.hook_data;
      if (hookData?.tool_name === 'Write') {
        const filePath: string = hookData.tool_input?.file_path || '';
        if (filePath.includes('.claude/plans/')) {
          const filename = filePath.split('/').pop() || filePath;
          notifications.push(makeRawNotificationEvent(event, 'PlanReady', `Plan written: ${filename}`));
        }
      }
    }

    return notifications;
  },
};

function makeResourceEvent(source: SnifferEvent, eventType: string, summary: string): SnifferEvent {
  return {
    ...source,
    id: `res-${source.id}`,
    event_type: eventType,
    layer: 'resource',
    summary,
    source_event_id: source.id,
  };
}

const RESOURCE_LAYER: LayerProcessor = {
  name: 'resource',
  process(scopedEvents) {
    const resourceEvents: SnifferEvent[] = [];

    for (const event of scopedEvents) {
      if (event.webhook_type !== 'hook_op') continue;
      const summary = event.event_type || 'hook_op';
      resourceEvents.push(makeResourceEvent(event, event.event_type, summary));
    }

    return resourceEvents;
  },
};

export const LAYER_PROCESSORS: LayerProcessor[] = [INFO_LAYER, RAW_NOTIFICATIONS_LAYER, RESOURCE_LAYER];
