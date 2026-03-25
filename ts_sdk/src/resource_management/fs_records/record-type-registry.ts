/**
 * RecordTypeRegistry — maps record type strings to FsRecord constructor functions.
 * Mirrors Python `fs.type_registry.TypeRegistry`.
 *
 * Each concrete FsRecord subclass registers itself at module load time via
 * `fsRecordTypeRegistry.register(...)`.  The registry enables polymorphic
 * deserialization: given a raw dict with a `type` field the correct class
 * can be looked up and instantiated.
 */
import type { FsRecordData } from './fs-record';

/** Constructor signature that every registered FsRecord class must satisfy. */
export type FsRecordConstructor = new (data?: Partial<FsRecordData>) => FsRecordData;

export class RecordTypeRegistry {
  private _types = new Map<string, FsRecordConstructor>();

  /** Register a record class for a given type string. */
  register(recordType: string, ctor: FsRecordConstructor): void {
    if (recordType) {
      this._types.set(recordType, ctor);
    }
  }

  /** Look up a registered constructor by type string. */
  get(recordType: string): FsRecordConstructor | undefined {
    return this._types.get(recordType);
  }

  /** Check whether a type is registered. */
  has(recordType: string): boolean {
    return this._types.has(recordType);
  }

  /** Return a snapshot of all registered types. */
  entries(): Map<string, FsRecordConstructor> {
    return new Map(this._types);
  }
}

/** Global singleton — all concrete FsRecord subclasses register here. */
export const fsRecordTypeRegistry = new RecordTypeRegistry();
