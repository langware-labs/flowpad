import { parseTag } from '../generator/TestPacketGenerator.js';
import type {
  EnrichedSequence,
  ValidationReport,
  ValidationResult,
  SimulationReport,
  PlaybackValidationReport,
} from '../types.js';
import type { ScrollContext } from '../scroll/ScrollContext.js';
import type { IXtermAdapter } from '../adapter/XtermAdapter.js';

/**
 * Shared core used by both validateReport() and PlaybackHarness.validateBuffer().
 * Iterates over virtualBuffer, compares each tagged row against the adapter.
 */
export function validateBufferRows(
  report: SimulationReport,
  adapter: IXtermAdapter,
): PlaybackValidationReport {
  const failures: PlaybackValidationReport['failures'] = [];
  let matchedRows = 0;
  let totalRows = 0;

  for (let liveIdx = 0; liveIdx < report.virtualBuffer.length; liveIdx++) {
    const vRow = report.virtualBuffer[liveIdx];
    if (vRow.logicalLine === null) continue;

    totalRows++;
    const absRow = report.totalScrolledOff + liveIdx;
    const lineText = adapter.getLineText(absRow);
    const parsed = lineText ? parseTag(lineText) : null;

    if (!parsed || parsed.logicalLine !== vRow.logicalLine) {
      failures.push({
        bufferRow: absRow,
        predicted: vRow.content.slice(0, 50),
        actual: lineText?.slice(0, 50) ?? null,
      });
    } else {
      matchedRows++;
    }
  }

  return { totalRows, matchedRows, failures };
}

/**
 * Validate an EnrichedSequence against the live ScrollContext.
 */
export function validate(
  enriched: EnrichedSequence,
  context: ScrollContext,
): ValidationReport {
  const results: ValidationResult[] = [];
  const { env } = enriched;
  const adapter = context.getAdapter();

  let totalPassed = 0;

  for (const ec of enriched.chunks) {
    for (const expected of ec.expectedLines) {
      const failures: ValidationResult['failures'] = [];

      const lineText = adapter.getLineText(expected.bufferRow);
      const parsed = lineText ? parseTag(lineText) : null;

      if (!parsed) {
        failures.push({
          field: 'tag',
          expected: `valid tag at row ${expected.bufferRow}`,
          actual: lineText?.slice(0, 50) ?? 'null',
        });
      } else {
        if (parsed.logicalLine !== expected.logicalLine) {
          failures.push({ field: 'logicalLine', expected: expected.logicalLine, actual: parsed.logicalLine });
        }
        if (parsed.bufferRow !== expected.bufferRow) {
          failures.push({ field: 'bufferRow', expected: expected.bufferRow, actual: parsed.bufferRow });
        }
        if (parsed.timestamp !== expected.timestamp) {
          failures.push({ field: 'timestamp', expected: expected.timestamp, actual: parsed.timestamp });
        }
      }

      const resolved = context.resolve({ lineNumber: expected.logicalLine });
      if (!resolved) {
        failures.push({ field: 'resolve', expected: 'TerminalCoord', actual: 'null' });
      } else {
        if (resolved.bufferIndex !== expected.bufferRow) {
          failures.push({ field: 'resolve.bufferIndex', expected: expected.bufferRow, actual: resolved.bufferIndex });
        }
        if (resolved.pixelY !== expected.pixelY) {
          failures.push({ field: 'resolve.pixelY', expected: expected.pixelY, actual: resolved.pixelY });
        }
      }

      const pass = failures.length === 0;
      if (pass) totalPassed++;
      results.push({ chunkSeq: ec.chunk.seq, logicalLine: expected.logicalLine, pass, failures });
    }
  }

  return { seed: env.seed, env, totalChecked: results.length, totalPassed, results };
}

/**
 * Validate a SimulationReport against an adapter.
 */
export function validateReport(
  report: SimulationReport,
  adapter: IXtermAdapter,
): PlaybackValidationReport {
  return validateBufferRows(report, adapter);
}
