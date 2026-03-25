/**
 * FsRecordRef — lightweight reference to a filesystem record.
 * Used for parent/child/origin relationships between records.
 */
export interface FsRecordRef {
  id: string;
  type: string;
  record_path?: string;
}

/** Serialize an FsRecordRef to a plain object. */
export function fsRecordRefToDict(ref: FsRecordRef): Record<string, unknown> {
  const d: Record<string, unknown> = { id: ref.id, type: ref.type };
  if (ref.record_path !== undefined) {
    d.record_path = ref.record_path;
  }
  return d;
}

/** Deserialize a plain object to an FsRecordRef. */
export function fsRecordRefFromDict(data: Record<string, unknown>): FsRecordRef {
  return {
    id: data.id as string,
    type: data.type as string,
    record_path: data.record_path as string | undefined,
  };
}
