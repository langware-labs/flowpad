import { LabelInfo, OntologyNames } from '../models/LabelInfo';

// Re-export OntologyNames for convenience
export { OntologyNames };

// Get the skill label prefix using the ontology name format: --{ontologyName}--
function getSkillLabelPrefix(): string {
  return `--${OntologyNames.SKILL}--`;
}

/**
 * Convert a skill string to a full label ID
 */
export function skillToLabel(skill: string): string {
  return `${getSkillLabelPrefix()}.${skill}`;
}

/**
 * Extract skill string from a label ID
 */
export function labelToSkill(label: string): string | null {
  const { ontology, path } = LabelInfo.parseLabel(label);
  if (ontology !== OntologyNames.SKILL) return null;
  return path;
}

/**
 * Check if a label ID is a skill label
 */
export function isSkillLabel(label: string): boolean {
  const { ontology } = LabelInfo.parseLabel(label);
  return ontology === OntologyNames.SKILL;
}
