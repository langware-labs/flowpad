import { isSkillLabel, ontologyStore, Resolvable } from '@sdk';
import { describe, expect, it } from 'vitest';

/**
 * Merge handler for labels with same-ontology deduplication.
 * Rule: If modelChoice contains labels from an ontology, remove all labels from that ontology in value.
 * Works with both registered and unregistered ontologies (based on --prefix-- format).
 */
function mergeLabelsWithOntologyDeduplication(resolvable: Resolvable<string[]>): string[] {
  const value = (resolvable.value as string[]) || [];
  const modelChoice = resolvable.modelChoice;

  if (!modelChoice || modelChoice.length === 0) {
    return value;
  }

  // Find which ontologies are present in modelChoice (based on label format)
  const modelOntologies = new Set<string>();
  for (const label of modelChoice) {
    const match = label.match(/^--([^-]+)--\./);
    if (match) {
      modelOntologies.add(match[1]);
    }
  }

  // Filter value to remove labels from conflicting ontologies
  const filteredValue = value.filter((label) => {
    const match = label.match(/^--([^-]+)--\./);
    if (match) {
      const ontology = match[1];
      // Remove if this ontology is in modelChoice
      return !modelOntologies.has(ontology);
    }
    // Keep ad-hoc labels
    return true;
  });

  // Merge: modelChoice first, then unique labels from filteredValue
  const result = [...modelChoice];
  for (const label of filteredValue) {
    if (!result.includes(label)) {
      result.push(label);
    }
  }

  return result;
}

describe('Resolvable with Ontology Merge Handler', () => {
  describe('Basic resolveHandler mechanism', () => {
    it('should use autoResolvedValue when no handler provided', () => {
      // When value is not 'auto', resolved returns value (user override)
      const resolvable = new Resolvable<string>('value1', 'modelChoice1');
      expect(resolvable.resolved).toBe('value1');
      expect(resolvable.autoResolvedValue).toBe('value1');

      // When value IS 'auto', resolved returns modelChoice
      const autoResolvable = new Resolvable<string>('auto', 'modelChoice1');
      expect(autoResolvable.resolved).toBe('modelChoice1');
      expect(autoResolvable.autoResolvedValue).toBe('modelChoice1');
    });

    it('should use resolveHandler when provided', () => {
      const handler = (r: Resolvable<string>) => `custom-${r.value}`;
      const resolvable = new Resolvable<string>('value1', 'modelChoice1', handler);
      // resolved uses custom handler
      expect(resolvable.resolved).toBe('custom-value1');
      // autoResolvedValue ignores handler and uses default logic (value unless value='auto')
      expect(resolvable.autoResolvedValue).toBe('value1');
    });

    it('should use resolveHandler with array types', () => {
      const handler = (r: Resolvable<string[]>) => {
        const value = r.value as string[];
        const modelChoice = r.modelChoice || [];
        return [...modelChoice, ...value, 'custom'];
      };
      const resolvable = new Resolvable<string[]>(['a', 'b'], ['c', 'd'], handler);
      expect(resolvable.resolved).toEqual(['c', 'd', 'a', 'b', 'custom']);
    });
  });

  describe('Ontology Store Integration', () => {
    it('should correctly identify skill labels', () => {
      expect(isSkillLabel('--skill--.solution_engineer')).toBe(true);
      expect(isSkillLabel('--skill--.code_debugger')).toBe(true);
      expect(isSkillLabel('manual')).toBe(false);
      expect(isSkillLabel('--task--.urgent')).toBe(false);
    });

    it('should return null for ad-hoc labels', () => {
      const labelInfo = ontologyStore.getLabelInfo('manual');
      expect(labelInfo).toBeNull();
    });

    it('should return null for unregistered ontology', () => {
      const labelInfo = ontologyStore.getLabelInfo('--task--.urgent');
      expect(labelInfo).toBeNull();
    });
  });

  describe('Same-Ontology Label Deduplication', () => {
    it('should replace skill labels when modelChoice has skill', () => {
      const resolvable = new Resolvable<string[]>(
        ['--skill--.software_architect', 'manual'],
        ['--skill--.solution_engineer'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      expect(result).toEqual(['--skill--.solution_engineer', 'manual']);
      expect(result.filter((l) => isSkillLabel(l)).length).toBe(1); // Only one skill
    });

    it('should remove multiple skill labels from value', () => {
      const resolvable = new Resolvable<string[]>(
        ['--skill--.software_architect', '--skill--.code_debugger', 'manual'],
        ['--skill--.solution_engineer'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      expect(result).toEqual(['--skill--.solution_engineer', 'manual']);
      expect(result.filter((l) => isSkillLabel(l)).length).toBe(1); // Only one skill
    });

    it('should preserve non-skill labels from value', () => {
      const resolvable = new Resolvable<string[]>(
        ['--skill--.software_architect', 'manual', 'priority', 'custom-tag'],
        ['--skill--.solution_engineer'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      expect(result).toContain('--skill--.solution_engineer');
      expect(result).toContain('manual');
      expect(result).toContain('priority');
      expect(result).toContain('custom-tag');
      expect(result.filter((l) => isSkillLabel(l)).length).toBe(1);
    });

    it('should preserve non-skill labels from modelChoice', () => {
      const resolvable = new Resolvable<string[]>(
        ['--skill--.software_architect', 'manual'],
        ['--skill--.solution_engineer', 'urgent', 'high-priority'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      expect(result).toContain('--skill--.solution_engineer');
      expect(result).toContain('manual');
      expect(result).toContain('urgent');
      expect(result).toContain('high-priority');
      expect(result.filter((l) => isSkillLabel(l)).length).toBe(1);
    });

    it('should deduplicate ad-hoc labels across value and modelChoice', () => {
      const resolvable = new Resolvable<string[]>(
        ['--skill--.software_architect', 'manual', 'urgent'],
        ['--skill--.solution_engineer', 'manual', 'urgent'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      expect(result).toEqual(['--skill--.solution_engineer', 'manual', 'urgent']);
      // Count occurrences
      expect(result.filter((l) => l === 'manual').length).toBe(1);
      expect(result.filter((l) => l === 'urgent').length).toBe(1);
    });

    it('should handle value with only ad-hoc labels', () => {
      const resolvable = new Resolvable<string[]>(
        ['manual', 'custom'],
        ['--skill--.solution_engineer', 'urgent'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      expect(result).toContain('--skill--.solution_engineer');
      expect(result).toContain('manual');
      expect(result).toContain('custom');
      expect(result).toContain('urgent');
    });

    it('should handle modelChoice with only ad-hoc labels', () => {
      const resolvable = new Resolvable<string[]>(
        ['--skill--.software_architect', 'manual'],
        ['urgent', 'high-priority'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      // No skill in modelChoice, so keep skill from value
      expect(result).toContain('--skill--.software_architect');
      expect(result).toContain('urgent');
      expect(result).toContain('high-priority');
      expect(result).toContain('manual');
    });

    it('should handle empty modelChoice (fallback to value)', () => {
      const resolvable = new Resolvable<string[]>(
        ['--skill--.software_architect', 'manual'],
        [],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      expect(result).toEqual(['--skill--.software_architect', 'manual']);
    });

    it('should handle null modelChoice (fallback to value)', () => {
      const resolvable = new Resolvable<string[]>(
        ['--skill--.software_architect', 'manual'],
        null,
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      expect(result).toEqual(['--skill--.software_architect', 'manual']);
    });

    it('should handle empty value', () => {
      const resolvable = new Resolvable<string[]>(
        [],
        ['--skill--.solution_engineer', 'urgent'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      expect(result).toEqual(['--skill--.solution_engineer', 'urgent']);
    });
  });

  describe('Multiple Ontologies (Future-Proof)', () => {
    it('should handle mixed ontology labels (skill + unregistered)', () => {
      const resolvable = new Resolvable<string[]>(
        ['--skill--.software_architect', '--task--.urgent', 'manual'],
        ['--skill--.solution_engineer', '--task--.high-priority'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      // Skill ontology: modelChoice wins
      expect(result).toContain('--skill--.solution_engineer');
      expect(result).not.toContain('--skill--.software_architect');

      // Task ontology: modelChoice wins (works for unregistered ontologies too)
      expect(result).toContain('--task--.high-priority');
      expect(result).not.toContain('--task--.urgent');

      // Ad-hoc labels preserved
      expect(result).toContain('manual');
    });

    it('should handle different ontologies without conflicts', () => {
      const resolvable = new Resolvable<string[]>(
        ['--skill--.software_architect', '--google--.drive', 'manual'],
        ['--task--.urgent'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      // Task in modelChoice, but skill and google in value - no conflict
      expect(result).toContain('--task--.urgent');
      expect(result).toContain('--skill--.software_architect');
      expect(result).toContain('--google--.drive');
      expect(result).toContain('manual');
    });
  });

  describe('Real-World SubAgent/Flow Scenarios', () => {
    it('should merge agent base_skill with message labels (no conflict)', () => {
      // SubAgent has software_architect
      const agentSkill = '--skill--.software_architect';

      // Message adds additional labels (no skill override)
      const resolvable = new Resolvable<string[]>(
        [agentSkill],
        ['manual', 'urgent'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      expect(result).toContain('--skill--.software_architect');
      expect(result).toContain('manual');
      expect(result).toContain('urgent');
    });

    it('should override agent base_skill with message baseSkill', () => {
      // SubAgent has software_architect
      const agentSkill = '--skill--.software_architect';

      // Message overrides with solution_engineer
      const messageSkill = '--skill--.solution_engineer';

      const resolvable = new Resolvable<string[]>(
        [agentSkill, 'manual'],
        [messageSkill, 'urgent'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      expect(result).toContain('--skill--.solution_engineer');
      expect(result).not.toContain('--skill--.software_architect');
      expect(result).toContain('manual');
      expect(result).toContain('urgent');
    });

    it('should handle message with skill in labels array', () => {
      // SubAgent has software_architect
      const agentSkill = '--skill--.software_architect';

      // Message adds skill via labels array (not baseSkill)
      const resolvable = new Resolvable<string[]>(
        [agentSkill],
        ['--skill--.code_debugger', 'manual'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      expect(result).toContain('--skill--.code_debugger');
      expect(result).not.toContain('--skill--.software_architect');
      expect(result).toContain('manual');
    });

    it('should handle conflicting skills in both value and modelChoice', () => {
      // Value has multiple skills (shouldn't happen but test it)
      const resolvable = new Resolvable<string[]>(
        ['--skill--.software_architect', '--skill--.code_debugger', 'manual'],
        ['--skill--.solution_engineer', 'urgent'],
        mergeLabelsWithOntologyDeduplication,
      );

      const result = resolvable.resolved;
      // Only modelChoice skill survives
      expect(result.filter((l) => isSkillLabel(l))).toEqual(['--skill--.solution_engineer']);
      expect(result).toContain('manual');
      expect(result).toContain('urgent');
    });
  });
});
