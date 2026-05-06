import type { GenericEntry } from '@sdk/utils/agent-transcript';
import { UserMessageView } from './entry-renderers/UserMessageView';
import { AssistantMessageView } from './entry-renderers/AssistantMessageView';
import { ToolUseView } from './entry-renderers/ToolUseView';
import { ToolResultView } from './entry-renderers/ToolResultView';
import { SystemView } from './entry-renderers/SystemView';
import { SummaryView } from './entry-renderers/SummaryView';
import { MetaView } from './entry-renderers/MetaView';
import { TokenUsageView } from './entry-renderers/TokenUsageView';
import { UnknownView } from './entry-renderers/UnknownView';

interface Props {
  entry: GenericEntry;
}

/** Single dispatch point for a typed transcript entry → its renderer. */
export function EntryRow({ entry }: Props) {
  switch (entry.kind) {
    case 'user_message':
      return <UserMessageView entry={entry} />;
    case 'assistant_message':
      return <AssistantMessageView entry={entry} />;
    case 'tool_use':
      return <ToolUseView entry={entry} />;
    case 'tool_result':
      return <ToolResultView entry={entry} />;
    case 'system':
      return <SystemView entry={entry} />;
    case 'summary':
      return <SummaryView entry={entry} />;
    case 'meta':
      return <MetaView entry={entry} />;
    case 'token_usage':
      return <TokenUsageView entry={entry} />;
    case 'unknown':
      return <UnknownView entry={entry} />;
  }
}
