import { RecordType } from '@sdk';

/** Types a sidebar section lists beside its own: the Documents (markdown) section
 *  also lists the read-only .docx / .txt files (`document_file`) of the same docs
 *  folders, which have no section of their own. */
const LISTED_WITH: Record<string, readonly string[]> = {
  [RecordType.MARKDOWN]: [RecordType.DOCUMENT_FILE],
};

/** Every record type the `type` section lists (itself first). */
export function sectionRecordTypes(type: string): string[] {
  return [type, ...(LISTED_WITH[type] ?? [])];
}
