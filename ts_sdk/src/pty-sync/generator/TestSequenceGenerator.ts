import { SeededRng } from './SeededRng.js';
import { buildPacket, TAG_LENGTH } from './TestPacketGenerator.js';
import { simulate } from '../simulator/TerminalSimulator.js';
import { VirtualTerminal } from '../simulator/VirtualTerminal.js';
import type { EnvSetup, EnrichedSequence, SimulationReport, OutputChunk } from '../types.js';
import { simulationReportToEnrichedSequence } from '../types.js';

export interface ScenarioData {
  enriched: EnrichedSequence;
  report: SimulationReport;
}

export interface GeneratorOptions {
  /** Number of chunks to produce. */
  numChunks: number;
  /**
   * For each chunk, how many visible characters (excluding \n) to produce.
   * If not provided, a random mix is used based on the seed.
   * Length must be >= TAG_LENGTH (42).
   */
  chunkLengths?: number[];
}

// ─── Scenario types ──────────────────────────────────────────────────────────

export type ChunkScenario =
  | { type: 'normal';    length: number }
  | { type: 'overwrite'; drafts: number; finalLength: number }
  | { type: 'ansi';      length: number; colorCode: string }
  | { type: 'wide';      wideChars: number }
  | { type: 'tab';       tabs: number }
  | { type: 'multiline'; lines: number; lengthPerLine: number }
  | { type: 'exact_cols' };

/**
 * Synthetic base timestamp: 2024-01-01T00:00:00.000Z in ms.
 * Each chunk gets baseTimestamp + chunkIndex * 1000 ms so timestamps are unique.
 */
const BASE_TIMESTAMP_MS = 1704067200000;

/**
 * Generate a deterministic test sequence using VirtualTerminal for pre-simulation.
 */
export function generateTestSequence(
  seed: number,
  env: EnvSetup,
  options: GeneratorOptions,
): EnrichedSequence {
  const rng = new SeededRng(seed);
  const { numChunks, chunkLengths } = options;

  // Step 1: determine chunk lengths
  const lengths: number[] = chunkLengths
    ? [...chunkLengths]
    : Array.from({ length: numChunks }, () => {
        if (rng.nextFloat() < 0.6) {
          return env.cols - 1; // no wrap
        } else {
          return env.cols + 1 + Math.floor(rng.nextFloat() * env.cols);
        }
      });

  // Step 2: pre-simulate with VirtualTerminal using placeholder chunks (r=0000)
  // to determine the bufferRow for each logical line.
  const encoder = new TextEncoder();
  const dummyRng = new SeededRng(seed + 999999); // separate rng for placeholder padding
  const placeholderChunks: OutputChunk[] = [];

  for (let ci = 0; ci < numChunks; ci++) {
    const totalChars = lengths[ci];
    if (totalChars < TAG_LENGTH) {
      throw new Error(`Chunk ${ci}: totalChars ${totalChars} < TAG_LENGTH ${TAG_LENGTH}`);
    }
    const timestamp = BASE_TIMESTAMP_MS + ci * 1000;
    // Use logicalLine = ci+1 and r = 0000 placeholder
    const packetStr = buildPacket(timestamp, ci + 1, 0, totalChars, dummyRng);
    placeholderChunks.push({ seq: ci + 1, data: encoder.encode(packetStr), timestamp });
  }

  const preVt = new VirtualTerminal(env);
  for (const chunk of placeholderChunks) preVt.processChunk(chunk);
  const preReport = preVt.getReport();

  // Build logicalLine → bufferRow map from pre-simulation
  const lineBufferRows = new Map<number, number>();
  for (const pResult of preReport.packetResults) {
    for (const row of pResult.rows) {
      if (row.logicalLine !== null && row.status !== 'overwritten') {
        lineBufferRows.set(row.logicalLine, row.bufferRow);
      }
    }
  }

  // Step 3: build real chunks with correct r values
  const realRng = new SeededRng(seed);
  // Consume the same random decisions as step 1 (length generation)
  if (!chunkLengths) {
    for (let ci = 0; ci < numChunks; ci++) {
      realRng.nextFloat();
      if (lengths[ci] > env.cols - 1) realRng.nextFloat();
    }
  }

  const chunks: OutputChunk[] = [];
  for (let ci = 0; ci < numChunks; ci++) {
    const logicalLine = ci + 1;
    const bufferRow = lineBufferRows.get(logicalLine) ?? 0;
    const timestamp = BASE_TIMESTAMP_MS + ci * 1000;
    const totalChars = lengths[ci];
    const packetStr = buildPacket(timestamp, logicalLine, bufferRow, totalChars, realRng);
    chunks.push({ seq: ci + 1, data: encoder.encode(packetStr), timestamp });
  }

  // Step 4: run real simulator to produce EnrichedSequence
  return simulate(env, chunks);
}

/**
 * Generate a test sequence from a list of ChunkScenarios.
 */
export function generateScenarioSequence(
  seed: number,
  env: EnvSetup,
  scenarios: ChunkScenario[],
): ScenarioData {
  const encoder = new TextEncoder();
  const rng = new SeededRng(seed);

  // Phase 1: generate placeholder chunks (r=0000) to determine buffer positions
  let logicalLineCounter = 0;
  const placeholderChunks: OutputChunk[] = [];
  let seqCounter = 1;

  for (const scenario of scenarios) {

    if (scenario.type === 'overwrite') {
      // Draft chunks: each is draftContent + \r (no \n, no tag)
      for (let d = 0; d < scenario.drafts; d++) {
        const draftContent = 'X'.repeat(Math.max(1, scenario.finalLength - TAG_LENGTH));
        const text = draftContent + '\r';
        placeholderChunks.push({
          seq: seqCounter,
          data: encoder.encode(text),
          timestamp: BASE_TIMESTAMP_MS + (seqCounter - 1) * 1000,
        });
        seqCounter++;
      }
      // Final commit chunk
      logicalLineCounter++;
      const ll = logicalLineCounter;
      const text = buildPacket(
        BASE_TIMESTAMP_MS + (seqCounter - 1) * 1000,
        ll,
        0, // placeholder
        scenario.finalLength,
        new SeededRng(seed + seqCounter),
      );
      placeholderChunks.push({
        seq: seqCounter,
        data: encoder.encode(text),
        timestamp: BASE_TIMESTAMP_MS + (seqCounter - 1) * 1000,
      });
      seqCounter++;
    } else if (scenario.type === 'multiline') {
      for (let ln = 0; ln < scenario.lines; ln++) {
        logicalLineCounter++;
        const ll = logicalLineCounter;
        const text = buildPacket(
          BASE_TIMESTAMP_MS + (seqCounter - 1) * 1000,
          ll,
          0,
          scenario.lengthPerLine,
          new SeededRng(seed + seqCounter),
        );
        placeholderChunks.push({
          seq: seqCounter,
          data: encoder.encode(text),
          timestamp: BASE_TIMESTAMP_MS + (seqCounter - 1) * 1000,
        });
        seqCounter++;
      }
    } else {
      logicalLineCounter++;
      const ll = logicalLineCounter;
      let text: string;

      if (scenario.type === 'normal') {
        text = buildPacket(
          BASE_TIMESTAMP_MS + (seqCounter - 1) * 1000,
          ll,
          0,
          scenario.length,
          rng,
        );
      } else if (scenario.type === 'ansi') {
        const inner = buildPacket(
          BASE_TIMESTAMP_MS + (seqCounter - 1) * 1000,
          ll,
          0,
          scenario.length,
          rng,
        ).slice(0, -1); // remove \n
        text = `\x1b[${scenario.colorCode}m${inner}\x1b[0m\n`;
      } else if (scenario.type === 'wide') {
        // wide chars scenario: tag + wide chars + \n
        const wideChar = '\u4e00'; // CJK, 2-col
        const wideSection = wideChar.repeat(scenario.wideChars);
        const tagContent = buildPacket(
          BASE_TIMESTAMP_MS + (seqCounter - 1) * 1000,
          ll,
          0,
          TAG_LENGTH,
          rng,
        ).slice(0, TAG_LENGTH);
        text = tagContent + wideSection + '\n';
      } else if (scenario.type === 'tab') {
        // tag + tabs + \n
        const tagContent = buildPacket(
          BASE_TIMESTAMP_MS + (seqCounter - 1) * 1000,
          ll,
          0,
          TAG_LENGTH,
          rng,
        ).slice(0, TAG_LENGTH);
        text = tagContent + '\t'.repeat(scenario.tabs) + '\n';
      } else {
        // exact_cols: tag(42) + padding(cols-42) + \n
        text = buildPacket(
          BASE_TIMESTAMP_MS + (seqCounter - 1) * 1000,
          ll,
          0,
          env.cols,
          rng,
        );
      }

      placeholderChunks.push({
        seq: seqCounter,
        data: encoder.encode(text),
        timestamp: BASE_TIMESTAMP_MS + (seqCounter - 1) * 1000,
      });
      seqCounter++;
    }
  }

  // Phase 2: pre-simulate to get bufferRows
  const preVt = new VirtualTerminal(env);
  for (const chunk of placeholderChunks) preVt.processChunk(chunk);
  const preReport = preVt.getReport();

  const lineBufferRows = new Map<number, number>();
  for (const pResult of preReport.packetResults) {
    for (const row of pResult.rows) {
      if (row.logicalLine !== null && row.status !== 'overwritten') {
        lineBufferRows.set(row.logicalLine, row.bufferRow);
      }
    }
  }

  // Phase 3: build real chunks with correct r values
  const realRng = new SeededRng(seed);
  let realSeq = 1;
  logicalLineCounter = 0;
  const realChunks: OutputChunk[] = [];

  for (const scenario of scenarios) {
    if (scenario.type === 'overwrite') {
      for (let d = 0; d < scenario.drafts; d++) {
        const draftContent = 'X'.repeat(Math.max(1, scenario.finalLength - TAG_LENGTH));
        const text = draftContent + '\r';
        realChunks.push({
          seq: realSeq,
          data: encoder.encode(text),
          timestamp: BASE_TIMESTAMP_MS + (realSeq - 1) * 1000,
        });
        realSeq++;
      }
      logicalLineCounter++;
      const ll = logicalLineCounter;
      const bufferRow = lineBufferRows.get(ll) ?? 0;
      const text = buildPacket(
        BASE_TIMESTAMP_MS + (realSeq - 1) * 1000,
        ll,
        bufferRow,
        scenario.finalLength,
        new SeededRng(seed + realSeq),
      );
      realChunks.push({
        seq: realSeq,
        data: encoder.encode(text),
        timestamp: BASE_TIMESTAMP_MS + (realSeq - 1) * 1000,
      });
      realSeq++;
    } else if (scenario.type === 'multiline') {
      for (let ln = 0; ln < scenario.lines; ln++) {
        logicalLineCounter++;
        const ll = logicalLineCounter;
        const bufferRow = lineBufferRows.get(ll) ?? 0;
        const text = buildPacket(
          BASE_TIMESTAMP_MS + (realSeq - 1) * 1000,
          ll,
          bufferRow,
          scenario.lengthPerLine,
          new SeededRng(seed + realSeq),
        );
        realChunks.push({
          seq: realSeq,
          data: encoder.encode(text),
          timestamp: BASE_TIMESTAMP_MS + (realSeq - 1) * 1000,
        });
        realSeq++;
      }
    } else {
      logicalLineCounter++;
      const ll = logicalLineCounter;
      const bufferRow = lineBufferRows.get(ll) ?? 0;
      let text: string;

      if (scenario.type === 'normal') {
        text = buildPacket(
          BASE_TIMESTAMP_MS + (realSeq - 1) * 1000,
          ll,
          bufferRow,
          scenario.length,
          realRng,
        );
      } else if (scenario.type === 'ansi') {
        const inner = buildPacket(
          BASE_TIMESTAMP_MS + (realSeq - 1) * 1000,
          ll,
          bufferRow,
          scenario.length,
          realRng,
        ).slice(0, -1);
        text = `\x1b[${scenario.colorCode}m${inner}\x1b[0m\n`;
      } else if (scenario.type === 'wide') {
        const wideChar = '\u4e00';
        const wideSection = wideChar.repeat(scenario.wideChars);
        const tagContent = buildPacket(
          BASE_TIMESTAMP_MS + (realSeq - 1) * 1000,
          ll,
          bufferRow,
          TAG_LENGTH,
          realRng,
        ).slice(0, TAG_LENGTH);
        text = tagContent + wideSection + '\n';
      } else if (scenario.type === 'tab') {
        const tagContent = buildPacket(
          BASE_TIMESTAMP_MS + (realSeq - 1) * 1000,
          ll,
          bufferRow,
          TAG_LENGTH,
          realRng,
        ).slice(0, TAG_LENGTH);
        text = tagContent + '\t'.repeat(scenario.tabs) + '\n';
      } else {
        // exact_cols
        text = buildPacket(
          BASE_TIMESTAMP_MS + (realSeq - 1) * 1000,
          ll,
          bufferRow,
          env.cols,
          realRng,
        );
      }

      realChunks.push({
        seq: realSeq,
        data: encoder.encode(text),
        timestamp: BASE_TIMESTAMP_MS + (realSeq - 1) * 1000,
      });
      realSeq++;
    }
  }

  // Phase 4: run real simulation
  const vt = new VirtualTerminal(env);
  for (const chunk of realChunks) vt.processChunk(chunk);
  const report = vt.getReport();
  return { enriched: simulationReportToEnrichedSequence(report, realChunks), report };
}

// Re-export for convenience
export { TAG_LENGTH };
