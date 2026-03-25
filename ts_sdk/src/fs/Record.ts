/**
 * Record — frontend reflection of a Python Record's filesystem layout.
 *
 * Fetched via GET /api/v1/graph/{type}/{id}/record/refs.
 * Exposes recordFolderRef (the record's shadow folder in records_root) and
 * mainRef (primary content file).
 * Use ref.child() chaining to navigate into subfolders/files.
 */

import { FSRef, FSRefJson } from './FSRef';

export interface RecordRefs {
  record_folder_ref: FSRefJson | null;
  main_ref: FSRefJson | null;
}

export class Record {
  readonly recordFolderRef: FSRef | null;
  readonly mainRef: FSRef | null;

  constructor(refs: RecordRefs) {
    this.recordFolderRef = refs.record_folder_ref ? FSRef.fromJson(refs.record_folder_ref) : null;
    this.mainRef = refs.main_ref ? FSRef.fromJson(refs.main_ref) : null;
  }
}
