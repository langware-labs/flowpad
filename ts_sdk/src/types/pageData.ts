import { Label } from '../entities/label';

export interface SectionLabel {
  label: string;
  node_key: string;
  scope: 'local' | 'global';
}

export interface InstructionSection {
  id: string; // Unique identifier for the section
  node_key: string; // Reference to the editor node (heading)
  title: string; // The heading text
  labels: Label[]; // Array of Label entities associated with this section
  order: number; // Order/position in the document
  created_at?: string;
  updated_at?: string;
}

export interface PageData {
  section_labels: SectionLabel[]; // Legacy - keep for backward compatibility
  instruction_sections: InstructionSection[]; // New structure
  page_labels?: Label[]; // Page-level labels managed separately from sections
}
