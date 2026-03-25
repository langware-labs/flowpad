/**
 * Compatibility shim — wraps VirtualTerminal to expose the original simulate() API.
 * All existing callers of simulate() continue to work unchanged.
 */
import type { EnvSetup, OutputChunk, EnrichedSequence } from '../types.js';
import { simulationReportToEnrichedSequence } from '../types.js';
import { VirtualTerminal } from './VirtualTerminal.js';

export function simulate(env: EnvSetup, chunks: OutputChunk[]): EnrichedSequence {
  const vt = new VirtualTerminal(env);
  for (const chunk of chunks) {
    vt.processChunk(chunk);
  }
  return simulationReportToEnrichedSequence(vt.getReport(), chunks);
}

export { VirtualTerminal };
