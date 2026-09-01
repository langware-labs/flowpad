import { FSRef } from '@sdk';
import { useJsonDoc } from '@src/hooks/use-json-doc';
import type { AgentTraceDoc } from './trace-types';

/** The trace.json behind an AgentTrace entity, read once per fsRef. */
export function useAgentTraceDoc(fsRef: FSRef | null) {
  return useJsonDoc<AgentTraceDoc>(fsRef);
}
