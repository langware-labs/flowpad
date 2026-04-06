"""File-system backed storage utilities."""

from .data_manager import DataManager as DataManager
from .exceptions import ReadOnlyProviderError as ReadOnlyProviderError
from .exceptions import ReadOnlyRecordError as ReadOnlyRecordError
from .factory.type_registry import type_registry as type_registry
from .fs_ref import BinaryFsRef as BinaryFsRef
from .fs_ref import FSRef as FSRef
from .fs_ref import JSONFsRef as JSONFsRef
from .fs_ref import TextFsRef as TextFsRef
from .json_file_record_store import JsonFileRecordStore as JsonFileRecordStore
from .json_file_record_store import JsonFileRecordStore as SourceFileRecordList  # noqa: F401 — legacy alias
from .json_file_record_store import _escape_json_pointer as _escape_json_pointer
from .property_record import PropertyRecord as PropertyRecord
from .record_field import RecordField as RecordField
from .provider import FSProvider as FSProvider
from .provider import GmailProvider as GmailProvider
from .provider import RecordProvider as RecordProvider
from .provider import get_provider as get_provider
from .provider import register_provider as register_provider
from .record import (
    Record as Record,
)
from .record import (
    RecordStatus as RecordStatus,
)
from .record import (
    get_default_records_root as get_default_records_root,
)
from .record import (
    get_default_records_data_root as get_default_records_data_root,
)
from .record import (
    get_flowpad_home as get_flowpad_home,
)
from .record import (
    parse_record_stem as parse_record_stem,
)
from .record import (
    record_stem as record_stem,
)
from .record import (
    set_default_records_root as set_default_records_root,
)
from .record import (
    set_default_records_data_root as set_default_records_data_root,
)
from .record_list import ListMode as ListMode
from .record_list import RecordList as RecordList
from .record_query import RecordQuery as RecordQuery
from .record_ref import RecordDataRef as RecordDataRef
from .record_ref import RecordRef as RecordRef
from .record_state import RecordState as RecordState
from .record_types import RecordType as RecordType
from .record_types import SkillitRecordType as SkillitRecordType
from .resource_record_list import ResourceRecordList as ResourceRecordList
from .scope import Scope as Scope
from .storage_layout import StorageLayout as StorageLayout
from .sync_protocol import RefType as RefType
from .sync_protocol import ResourceType as ResourceType
from .sync_protocol import SyncOperation as SyncOperation
