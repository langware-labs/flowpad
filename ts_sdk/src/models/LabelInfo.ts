// Label delimiter constant
export const LABEL_DELIMITER = '.';

/**
 * Ontology names enum - Single source of truth for all ontology identifiers
 * Use these constants instead of magic strings to ensure consistency
 */
export enum OntologyNames {
  SKILL = 'skill',
  GOOGLE = 'google',
  TASK = 'task',
  GOAL = 'goal',
}

/**
 * LabelInfo represents a label with metadata.
 * Labels can be:
 * - Ontology labels: "--<ontology>--.<path>" (e.g., "--skill--.solution_engineer")
 * - Ad-hoc labels: plain strings without ontology prefix (e.g., "manual")
 */
export class LabelInfo {
  constructor(
    public label: string,
    public description?: string,
    public color?: string | null,
    public parent?: string,
  ) {}

  /**
   * Get display name (last segment of label path)
   * Examples:
   * - "--skill--.solution_engineer" => "solution_engineer"
   * - "--google--.drive.upload" => "upload"
   * - "manual" => "manual"
   */
  get display(): string {
    return this.label.split(LABEL_DELIMITER).pop() || this.label;
  }

  /**
   * Parse a label ID into ontology name and path.
   * Format: "--<ontology>--.<path>"
   *
   * Examples:
   * - "--skill--.solution_engineer" => { ontology: "skill", path: "solution_engineer" }
   * - "--google--.drive.upload" => { ontology: "google", path: "drive.upload" }
   * - "manual" => { ontology: null, path: "manual" }
   *
   * @param labelId Full label ID
   * @returns Object with ontology name (null for ad-hoc) and path
   */
  static parseLabel(labelId: string): { ontology: string | null; path: string } {
    const match = labelId.match(/^--([^-]+)--\.(.+)$/);
    if (!match) {
      // Ad-hoc label without ontology prefix
      return { ontology: null, path: labelId };
    }
    return { ontology: match[1], path: match[2] };
  }
}

export class LabelInfoHelper {
  /**
   * Return the last segment of the label as the 'keyword'.
   */
  static getKeyword(labelInfo: LabelInfo): string {
    return labelInfo.label.split(LABEL_DELIMITER).pop() || '';
  }
}
