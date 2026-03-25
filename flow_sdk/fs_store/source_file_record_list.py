# Backward-compat shim — canonical location is json_file_record_store.py
from flow_sdk.fs_store.json_file_record_store import (
    JsonFileRecordStore as JsonFileRecordStore,
    JsonFileRecordStore as SourceFileRecordList,  # legacy alias
    _escape_json_pointer as _escape_json_pointer,
    _unescape_json_pointer as _unescape_json_pointer,
    _resolve_pointer as _resolve_pointer,
    _set_pointer as _set_pointer,
    _delete_pointer as _delete_pointer,
    _default_record_to_json as _default_record_to_json,
)
