import { LabelInfo, OntologyNames } from '../models/LabelInfo';
import { Ontology } from '../models/Ontology';

/**
 * OntologyStore manages all registered ontologies.
 * Provides lookup methods to get ontologies and label info.
 */
export class OntologyStore {
  private ontologies: Map<string, Ontology> = new Map();

  /**
   * Register an ontology in the store
   */
  registerOntology(ontology: Ontology): void {
    this.ontologies.set(ontology.name, ontology);
  }

  /**
   * Get an ontology by name
   * @param name Ontology name (e.g., "skill", "google")
   * @returns Ontology if registered, null otherwise
   */
  getOntology(name: string): Ontology | null {
    return this.ontologies.get(name) || null;
  }

  /**
   * Get label info from any registered ontology.
   * Automatically determines which ontology to query based on label prefix.
   *
   * Examples:
   * - getLabelInfo("--google--.drive") => queries google ontology
   * - getLabelInfo("manual") => returns null (ad-hoc label)
   *
   * @param labelId Full label ID
   * @returns LabelInfo if found, null otherwise
   */
  getLabelInfo(labelId: string): LabelInfo | null {
    const { ontology } = LabelInfo.parseLabel(labelId);

    // Ad-hoc labels have no ontology
    if (!ontology) {
      return null;
    }

    // Look up ontology
    const ont = this.getOntology(ontology);
    if (!ont) {
      return null;
    }

    // Get label info from ontology
    return ont.getLabelInfo(labelId);
  }

  /**
   * Get all registered ontology names
   */
  getOntologyNames(): string[] {
    return Array.from(this.ontologies.keys());
  }
}

/**
 * Deduplicate and filter labels according to ontology rules:
 * 1. Remove exact duplicates
 * 2. Keep only one label per ontology (keeps the FIRST one encountered)
 * 3. Allow multiple custom/ad-hoc labels
 *
 * When used with addLabel([newLabel, ...existingLabels]), this keeps the new label
 * and filters out any old label from the same ontology.
 *
 * @param labels - Array of label strings to deduplicate
 * @returns Deduplicated array with only one label per ontology
 */
export function labelsDedup(labels: string[]): string[] {
  const seen = new Set<string>();
  const ontologyMap = new Map<string, string>(); // ontologyName -> labelId
  const deduped: string[] = [];

  for (const label of labels) {
    // Skip exact duplicates
    if (seen.has(label)) {
      continue;
    }

    const { ontology } = LabelInfo.parseLabel(label);

    if (ontology) {
      // Ontology label - check if we already have one from this ontology
      const existing = ontologyMap.get(ontology);
      if (existing) {
        // Skip this label - we already have one from this ontology
        continue;
      }
      ontologyMap.set(ontology, label);
    }

    seen.add(label);
    deduped.push(label);
  }

  return deduped;
}

// Bootstrap: Create global ontology store
export const ontologyStore = new OntologyStore();
