/**
 * StorageLayout — how a record type is persisted on disk.
 *
 * FILE       – one JSON file per record (directory-based storage)
 * LIST_ITEM  – many records inside a single JSON array file
 * FOLDER     – record is a directory containing child files
 */
export enum StorageLayout {
  FILE = 'file',
  LIST_ITEM = 'list_item',
  FOLDER = 'folder',
}
