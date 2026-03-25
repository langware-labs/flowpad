import { InstructionFile } from '../InstructionFile';

/**
 * CompilerOptions for customizing compilation behavior
 */
export interface CompilerOptions {
  /** Version string for flow-header (default: "1.0") */
  version?: string;
}

/**
 * SkillCompiler is the base abstract class for compiling InstructionFiles.
 *
 * Compilers transform uncompiled markdown content into structured MDO format
 * with flow-do elements for each instruction.
 *
 * Usage:
 * ```
 * const compiler = new LineBreakCompiler();
 * const compiled = compiler.compile(instructionFile);
 * ```
 */
export abstract class SkillCompiler {
  /** Static counter for generating unique IDs, starts at 500 */
  private static idCounter: number = 500;

  protected options: CompilerOptions;

  constructor(options: CompilerOptions = {}) {
    this.options = {
      version: '1.0',
      ...options,
    };
  }

  /**
   * Generate a unique ID for a flow element.
   * Returns a base64-encoded representation of an incrementing counter.
   * Counter starts at 500 and increments by 1 on each call.
   */
  protected getId(): string {
    const id = SkillCompiler.idCounter++;
    return this.intToBase64(id);
  }

  /**
   * Convert an integer to a base64 string.
   * Uses a URL-safe base64 encoding without padding.
   */
  private intToBase64(num: number): string {
    // Convert number to bytes (big-endian)
    const bytes: number[] = [];
    let n = num;
    do {
      bytes.unshift(n & 0xff);
      n = Math.floor(n / 256);
    } while (n > 0);

    // Convert bytes to base64
    const binary = String.fromCharCode(...bytes);
    // Use btoa for browser, handle Node.js environment
    const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');

    // Return URL-safe base64 without padding
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * Reset the ID counter (useful for testing)
   */
  static resetIdCounter(value: number = 500): void {
    SkillCompiler.idCounter = value;
  }

  /**
   * Get the current ID counter value (useful for testing)
   */
  static getIdCounter(): number {
    return SkillCompiler.idCounter;
  }

  /**
   * Compile an InstructionFile into a new InstructionFile with flow elements.
   * @param file The source InstructionFile to compile
   * @returns A new compiled InstructionFile with flow-header and flow-do elements
   */
  compile(file: InstructionFile): InstructionFile {
    if (file.compiled) {
      // Already compiled - return as-is
      return file;
    }

    // Extract instructions from source content
    const instructions = this.extractInstructions(file.content);

    // Build compiled content
    const compiledContent = this.buildCompiledContent(file, instructions);

    return InstructionFile.fromContent(compiledContent);
  }

  /**
   * Extract instructions from raw content.
   * Subclasses implement this to define how content is split into instructions.
   * @param content Raw markdown content
   * @returns Array of instruction strings
   */
  protected abstract extractInstructions(content: string): string[];

  /**
   * Build the compiled content with flow-header and flow-do elements.
   */
  protected buildCompiledContent(file: InstructionFile, instructions: string[]): string {
    const lines: string[] = [];

    // Add flow-header
    lines.push(this.buildFlowHeader(file));

    // Add flow-do for each instruction with unique base64 IDs
    instructions.forEach((instruction) => {
      const id = this.getId();
      lines.push(`<!-- <flow-do id="${id}" /> -->${instruction}`);
    });

    return lines.join('\n');
  }

  /**
   * Build the flow-header element with metadata
   */
  protected buildFlowHeader(file: InstructionFile): string {
    const timestamp = new Date().toISOString();
    const version = this.options.version || '1.0';
    const sourceAttr = file.vfsPath ? ` source="${file.vfsPath.absVfsPath}"` : '';

    return `<!-- <flow-header version="${version}" compiled-at="${timestamp}"${sourceAttr} /> -->`;
  }
}
