"""Filesystem document reads and revision-checked, lossless body updates."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import yaml
from pydantic import Field, model_validator

from flow_sdk.capsules import snapshot_capsule_blocks, strip_capsule_blocks
from flow_sdk.capsules.atomic import atomic_write, capsule_lock
from flow_sdk.schema.data_spec.spec import DataSpec


class DocumentConflict(ValueError):
    def __init__(self, path: Path, current_revision: str | None):
        self.path = path
        self.current_revision = current_revision
        super().__init__(f"File changed outside this editor: {path}")


class DocumentPatch(DataSpec):
    body: str | None = None
    set_fields: dict[str, Any] = Field(default_factory=dict)
    drop_fields: tuple[str, ...] = ()

    @model_validator(mode="after")
    def check_keys(self):
        if set(self.set_fields).intersection(self.drop_fields):
            raise ValueError("A field cannot be both set and removed")
        return self


class AssetDocument(DataSpec):
    raw_text: str
    body: str
    fields: dict[str, Any] = Field(default_factory=dict)
    body_start_line: int = 1
    metadata_error: str | None = None
    revision: str


def content_revision(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _header(text: str) -> tuple[str, str, str | None]:
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return "", text, None
    for index, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            return "".join(lines[:index + 1]), "".join(lines[index + 1:]), "".join(lines[1:index])
    raise ValueError("Unclosed YAML frontmatter")


class _DocumentLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        self.flatten_mapping(node)
        keys = [self.construct_object(key, deep=deep) for key, _ in node.value]
        if any(not isinstance(key, str) for key in keys):
            raise ValueError("Document metadata keys must be strings")
        if len(set(keys)) != len(keys):
            raise ValueError("Duplicate document metadata key")
        return super().construct_mapping(node, deep=deep)


def read_document_bytes(data: bytes) -> AssetDocument:
    text = data.decode("utf-8")
    fields = {}
    error = None
    header = ""
    body = text
    try:
        header, body, yaml_text = _header(text)
        if yaml_text is not None:
            parsed = yaml.load(yaml_text, Loader=_DocumentLoader)
            if parsed is not None and not isinstance(parsed, dict):
                raise ValueError("Document frontmatter must be a mapping")
            fields = parsed or {}
    except (ValueError, yaml.YAMLError) as exc:
        error = str(exc)
    try:
        body = strip_capsule_blocks(body)
    except ValueError as exc:
        error = error or str(exc)
    return AssetDocument(raw_text=text, body=body, fields=fields,
                         body_start_line=len(header.splitlines()) + 1,
                         metadata_error=error, revision=content_revision(data))


def read_document(path: str | Path) -> AssetDocument:
    return read_document_bytes(Path(path).read_bytes())


def patch_document_text(text: str, patch: DocumentPatch, *, allow_identity: bool = False,
                        prepend: bool = False) -> str:
    document = read_document_bytes(text.encode("utf-8"))
    header, original_body, _ = _header(text)
    metadata_changed = bool(patch.set_fields or patch.drop_fields)
    if not allow_identity and {"id", "asset_id"}.intersection((*patch.set_fields, *patch.drop_fields)):
        raise ValueError("Document updates cannot change asset identity")
    if metadata_changed and document.metadata_error:
        raise ValueError(document.metadata_error)
    fields = {key: value for key, value in document.fields.items() if key not in patch.drop_fields}
    fields.update(patch.set_fields)
    body_changed = patch.body is not None and patch.body != document.body
    if not body_changed and fields == document.fields:
        return text
    if metadata_changed:
        from flow_sdk.assets.frontmatter import _render_frontmatter
        if prepend:
            fields = {**patch.set_fields, **fields}
        newline = "\r\n" if "\r\n" in text else "\n"
        header = _render_frontmatter(fields).replace("\n", newline) + newline
    if body_changed:
        # Identity/tag capsules belong to the existing file, never the editor's draft.
        blocks = snapshot_capsule_blocks(original_body)
        original_body = strip_capsule_blocks(patch.body)
        if blocks:
            newline = "\r\n" if "\r\n" in text else "\n"
            original_body += ("" if original_body.endswith(newline * 2) else newline * 2)
            original_body += (newline * 2).join(blocks)
    return header + original_body


def _save_document(path: str | Path, patch: DocumentPatch, *, expected_revision: str | None = None,
                   version_base: str | None = None, create: bool = False,
                   replace_fields: bool = False) -> AssetDocument:
    """Serialize cooperating writers; external writers cannot be locked by us.

    Internal callers may patch the latest file without a supplied revision.
    Editor transports require the revision returned with their loaded document.
    """
    occurrence = Path(path).absolute()
    target = occurrence.resolve()
    with capsule_lock(target):
        if occurrence.resolve() != target:
            raise DocumentConflict(occurrence, None)
        existed = True
        try:
            before = target.read_bytes()
        except FileNotFoundError:
            if expected_revision is not None:
                raise DocumentConflict(occurrence, None) from None
            if not create:
                raise
            existed = False
            before = b""
        revision = content_revision(before)
        if expected_revision is not None and expected_revision != revision:
            raise DocumentConflict(occurrence, revision)
        if patch.body is not None:
            from flow_sdk.capsules.line_comment import COMMENT_LEADERS, LineCommentCapsule

            if target.suffix.casefold() in COMMENT_LEADERS and LineCommentCapsule(target).names():
                raise ValueError("Source files with positional capsules do not support document body replacement")
        allow_identity = False
        if create:
            document = read_document_bytes(before)
            if replace_fields and document.metadata_error:
                raise ValueError(document.metadata_error)
            fields = dict(patch.set_fields)
            for key in ("id", "asset_id"):
                if key not in fields:
                    continue
                value = fields[key]
                if key in document.fields:
                    if value != document.fields[key]:
                        raise ValueError("Document updates cannot change asset identity")
                    del fields[key]
                else:
                    from flow_sdk.api.api_types.identifier import is_valid_entity_id

                    if key != "id" or not is_valid_entity_id(str(value)):
                        raise ValueError("New document identity must be UUID v4/v5")
                    if existed:
                        from flow_sdk.capsules.code_comment import CodeCommentCapsule

                        legacy = CodeCommentCapsule(target).read("identity")
                        if legacy is not None and legacy.data.get("id") != value:
                            raise ValueError("Document updates cannot change asset identity")
                    allow_identity = True
            dropped = tuple(key for key in document.fields
                            if key not in patch.set_fields and key not in {"id", "asset_id"}) if replace_fields else ()
            patch = DocumentPatch(body=patch.body, set_fields=fields, drop_fields=dropped)
        after = patch_document_text(before.decode("utf-8"), patch, allow_identity=allow_identity).encode("utf-8")
        if after != before and version_base is not None:
            from flow_sdk.assets.versioning import version_document
            after = version_document(after.decode("utf-8"), version_base).encode("utf-8")
        # Recheck before even the no-op return, including a changed symlink target.
        try:
            current = target.read_bytes()
        except FileNotFoundError:
            if existed:
                raise DocumentConflict(occurrence, None) from None
            current = b""
        if occurrence.resolve() != target or current != before:
            raise DocumentConflict(occurrence, content_revision(current))
        atomic_write(target, after)
        return read_document_bytes(after)


def update_document(path: str | Path, patch: DocumentPatch, *, expected_revision: str | None = None,
                    version_base: str | None = None) -> AssetDocument:
    """Patch an existing document under its shared writer lock."""
    return _save_document(path, patch, expected_revision=expected_revision, version_base=version_base)


def write_document(path: str | Path, *, body: str | None = None, fields: dict[str, Any] | None = None,
                   replace_fields: bool = False) -> AssetDocument:
    """Create or update a Markdown document, retaining existing identity and capsules.

    Complete spec writers can replace mutable metadata; partial updates merge it.
    An initial canonical identity may be supplied, but an existing identity cannot
    be replaced or removed by these ordinary document writes.
    """
    return _save_document(path, DocumentPatch(body=body, set_fields=fields or {}),
                          create=True, replace_fields=replace_fields)
