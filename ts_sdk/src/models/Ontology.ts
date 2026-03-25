import { LabelInfo } from './LabelInfo';

/**
 * Ontology represents a collection of related labels.
 * Examples: "skill", "google", "task"
 */
export class Ontology {
  constructor(
    public name: string,
    private labels: Map<string, LabelInfo>,
  ) {}

  /**
   * Get the label prefix for this ontology.
   * Format: --{ontologyName}--
   *
   * Examples:
   * - skillOntology.labelPrefix => "--skill--"
   * - googleOntology.labelPrefix => "--google--"
   */
  get labelPrefix(): string {
    return `--${this.name}--`;
  }

  /**
   * Get label info by full label ID.
   * The label ID must have the correct ontology prefix.
   *
   * Examples:
   * - skillOntology.getLabelInfo("--skill--.solution_engineer") => LabelInfo
   * - skillOntology.getLabelInfo("--google--.drive") => null (wrong ontology)
   * - skillOntology.getLabelInfo("manual") => null (no ontology prefix)
   *
   * @param labelId Full label ID with ontology prefix
   * @returns LabelInfo if found in this ontology, null otherwise
   */
  getLabelInfo(labelId: string): LabelInfo | null {
    const { ontology, path } = LabelInfo.parseLabel(labelId);

    // Validate ontology matches
    if (ontology !== this.name) {
      return null;
    }

    // Look up by path
    return this.labels.get(path) || null;
  }

  /**
   * Get all labels in this ontology
   */
  getAllLabels(): LabelInfo[] {
    return Array.from(this.labels.values());
  }

  /**
   * Check if a label exists in this ontology
   */
  hasLabel(path: string): boolean {
    return this.labels.has(path);
  }
}
