import { CompilerOptions, SkillCompiler } from './SkillCompiler';

/**
 * LineBreakCompiler options
 */
export interface LineBreakCompilerOptions extends CompilerOptions {
  /** Skip empty lines (default: true) */
  skipEmptyLines?: boolean;
  /** Trim whitespace from each line (default: true) */
  trimLines?: boolean;
  /** Skip lines starting with # (markdown headers) (default: false) */
  skipHeaders?: boolean;
}

/**
 * LineBreakCompiler splits content by line breaks.
 * Each non-empty line becomes a flow-do instruction.
 *
 * Example:
 * Input:
 * ```
 * First instruction
 * Second instruction
 * Third instruction
 * ```
 *
 * Output:
 * ```
 * <!-- <flow-header version="1.0" compiled-at="..." /> -->
 * <!-- <flow-do id="1" /> -->First instruction
 * <!-- <flow-do id="2" /> -->Second instruction
 * <!-- <flow-do id="3" /> -->Third instruction
 * ```
 */
export class LineBreakCompiler extends SkillCompiler {
  protected override options: LineBreakCompilerOptions;

  constructor(options: LineBreakCompilerOptions = {}) {
    super(options);
    this.options = {
      version: '1.0',
      skipEmptyLines: true,
      trimLines: true,
      skipHeaders: false,
      ...options,
    };
  }

  /**
   * Extract instructions by splitting on line breaks
   */
  protected extractInstructions(content: string): string[] {
    let lines = content.split('\n');

    // Trim lines if enabled
    if (this.options.trimLines) {
      lines = lines.map((line) => line.trim());
    }

    // Filter empty lines if enabled
    if (this.options.skipEmptyLines) {
      lines = lines.filter((line) => line.length > 0);
    }

    // Skip markdown headers if enabled
    if (this.options.skipHeaders) {
      lines = lines.filter((line) => !line.startsWith('#'));
    }

    return lines;
  }
}
