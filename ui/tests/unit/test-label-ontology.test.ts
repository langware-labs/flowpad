import { describe, expect, it, beforeEach } from 'vitest';
import { LabelInfo } from '@sdk';
import { Ontology } from '@sdk';
import { OntologyStore } from '@sdk';
import { OntologyNames } from '@sdk';

describe('LabelInfo', () => {
  describe('display property', () => {
    it('should return last segment for ontology label', () => {
      const label = new LabelInfo('--skill--.solution_engineer', 'Solution Engineer');
      expect(label.display).toBe('solution_engineer');
    });

    it('should return last segment for hierarchical label', () => {
      const label = new LabelInfo('--google--.drive.upload', 'Upload to Drive');
      expect(label.display).toBe('upload');
    });

    it('should return full label for ad-hoc label', () => {
      const label = new LabelInfo('manual', 'Manual label');
      expect(label.display).toBe('manual');
    });

    it('should return full label for single segment', () => {
      const label = new LabelInfo('--task--.priority', 'Priority');
      expect(label.display).toBe('priority');
    });
  });

  describe('parseLabel static method', () => {
    it('should parse ontology label with single segment', () => {
      const result = LabelInfo.parseLabel('--skill--.solution_engineer');
      expect(result).toEqual({
        ontology: OntologyNames.SKILL,
        path: 'solution_engineer',
      });
    });

    it('should parse ontology label with multiple segments', () => {
      const result = LabelInfo.parseLabel('--google--.drive.upload');
      expect(result).toEqual({
        ontology: OntologyNames.GOOGLE,
        path: 'drive.upload',
      });
    });

    it('should parse ad-hoc label without ontology', () => {
      const result = LabelInfo.parseLabel('manual');
      expect(result).toEqual({
        ontology: null,
        path: 'manual',
      });
    });

    it('should handle label with dots but no ontology prefix', () => {
      const result = LabelInfo.parseLabel('my.custom.label');
      expect(result).toEqual({
        ontology: null,
        path: 'my.custom.label',
      });
    });
  });
});

describe('Ontology', () => {
  let skillOntology: Ontology;

  beforeEach(() => {
    const labels = new Map<string, LabelInfo>([
      ['solution_engineer', new LabelInfo('solution_engineer', 'Solution Engineer', null)],
      ['software_architect', new LabelInfo('software_architect', 'System Architect', null)],
      ['code_debugger', new LabelInfo('code_debugger', 'Code Debugger', null)],
    ]);
    skillOntology = new Ontology(OntologyNames.SKILL, labels);
  });

  describe('getLabelInfo', () => {
    it('should get label info with correct ontology prefix', () => {
      const info = skillOntology.getLabelInfo('--skill--.solution_engineer');
      expect(info).toBeTruthy();
      expect(info?.label).toBe('solution_engineer');
      expect(info?.description).toBe('Solution Engineer');
    });

    it('should return null for wrong ontology prefix', () => {
      const info = skillOntology.getLabelInfo('--google--.drive');
      expect(info).toBeNull();
    });

    it('should return null for non-existent label in correct ontology', () => {
      const info = skillOntology.getLabelInfo('--skill--.nonexistent');
      expect(info).toBeNull();
    });

    it('should return null for ad-hoc label without prefix', () => {
      const info = skillOntology.getLabelInfo('manual');
      expect(info).toBeNull();
    });

    it('should handle hierarchical labels', () => {
      const labels = new Map<string, LabelInfo>([
        ['drive.upload', new LabelInfo('drive.upload', 'Upload to Drive', null)],
      ]);
      const googleOntology = new Ontology(OntologyNames.GOOGLE, labels);

      const info = googleOntology.getLabelInfo('--google--.drive.upload');
      expect(info).toBeTruthy();
      expect(info?.label).toBe('drive.upload');
    });
  });
});

describe('OntologyStore', () => {
  let store: OntologyStore;

  beforeEach(() => {
    store = new OntologyStore();
  });

  describe('registerOntology and getOntology', () => {
    it('should register and retrieve ontology', () => {
      const labels = new Map<string, LabelInfo>([
        ['solution_engineer', new LabelInfo('solution_engineer', 'Solution Engineer', null)],
      ]);
      const skillOntology = new Ontology(OntologyNames.SKILL, labels);

      store.registerOntology(skillOntology);

      const retrieved = store.getOntology(OntologyNames.SKILL);
      expect(retrieved).toBe(skillOntology);
    });

    it('should return null for non-existent ontology', () => {
      const retrieved = store.getOntology('nonexistent');
      expect(retrieved).toBeNull();
    });

    it('should allow multiple ontologies', () => {
      const skillLabels = new Map<string, LabelInfo>([
        ['solution_engineer', new LabelInfo('solution_engineer', 'Solution Engineer', null)],
      ]);
      const googleLabels = new Map<string, LabelInfo>([['drive', new LabelInfo('drive', 'Google Drive', null)]]);

      store.registerOntology(new Ontology(OntologyNames.SKILL, skillLabels));
      store.registerOntology(new Ontology(OntologyNames.GOOGLE, googleLabels));

      expect(store.getOntology(OntologyNames.SKILL)).toBeTruthy();
      expect(store.getOntology(OntologyNames.GOOGLE)).toBeTruthy();
    });
  });

  describe('getLabelInfo', () => {
    beforeEach(() => {
      const skillLabels = new Map<string, LabelInfo>([
        ['solution_engineer', new LabelInfo('solution_engineer', 'Solution Engineer', null)],
        ['software_architect', new LabelInfo('software_architect', 'System Architect', null)],
      ]);
      const googleLabels = new Map<string, LabelInfo>([
        ['drive.upload', new LabelInfo('drive.upload', 'Upload to Drive', null)],
      ]);

      store.registerOntology(new Ontology(OntologyNames.SKILL, skillLabels));
      store.registerOntology(new Ontology(OntologyNames.GOOGLE, googleLabels));
    });

    it('should get label info from correct ontology', () => {
      const info = store.getLabelInfo('--skill--.solution_engineer');
      expect(info).toBeTruthy();
      expect(info?.label).toBe('solution_engineer');
      expect(info?.description).toBe('Solution Engineer');
    });

    it('should get label info from different ontology', () => {
      const info = store.getLabelInfo('--google--.drive.upload');
      expect(info).toBeTruthy();
      expect(info?.label).toBe('drive.upload');
    });

    it('should return null for non-existent ontology', () => {
      const info = store.getLabelInfo('--task--.priority');
      expect(info).toBeNull();
    });

    it('should return null for ad-hoc label', () => {
      const info = store.getLabelInfo('manual');
      expect(info).toBeNull();
    });

    it('should return null for label not in ontology', () => {
      const info = store.getLabelInfo('--skill--.nonexistent');
      expect(info).toBeNull();
    });
  });
});

describe('Integration: Label flow AS IS', () => {
  let store: OntologyStore;

  beforeEach(() => {
    // Set up a local store with a skill ontology for integration testing
    store = new OntologyStore();
    const skillLabels = new Map<string, LabelInfo>([
      ['solution_engineer', new LabelInfo('solution_engineer', 'Solution Engineer', null)],
      ['software_architect', new LabelInfo('software_architect', 'System Architect', null)],
    ]);
    store.registerOntology(new Ontology(OntologyNames.SKILL, skillLabels));
  });

  it('should preserve full label format throughout system', () => {
    // Labels flow AS IS - no stripping or conversion
    const fullLabel = '--skill--.solution_engineer';

    // Parse when needed
    const { ontology, path } = LabelInfo.parseLabel(fullLabel);
    expect(ontology).toBe(OntologyNames.SKILL);
    expect(path).toBe('solution_engineer');

    // Get info when needed
    const info = store.getLabelInfo(fullLabel);
    expect(info?.label).toBe('solution_engineer');

    // Display when needed
    expect(info?.display).toBe('solution_engineer');

    // Original label unchanged
    expect(fullLabel).toBe('--skill--.solution_engineer');
  });

  it('should handle mixed label types', () => {
    const labels = [
      '--skill--.solution_engineer', // Ontology label
      'manual', // Ad-hoc label
      '--google--.drive', // Different ontology (not registered)
    ];

    // Get info for each
    const skillInfo = store.getLabelInfo(labels[0]);
    expect(skillInfo).toBeTruthy();

    const manualInfo = store.getLabelInfo(labels[1]);
    expect(manualInfo).toBeNull(); // Ad-hoc not in ontology

    const googleInfo = store.getLabelInfo(labels[2]);
    expect(googleInfo).toBeNull(); // Google ontology not registered

    // All labels unchanged
    expect(labels[0]).toBe('--skill--.solution_engineer');
    expect(labels[1]).toBe('manual');
    expect(labels[2]).toBe('--google--.drive');
  });
});
