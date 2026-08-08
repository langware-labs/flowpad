import fnmatch
import logging
import uuid
from copy import deepcopy
from typing import List, Optional

import numpy as np
from pydantic import BaseModel, Field, PrivateAttr, model_serializer, model_validator

from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.knowledge_base.knowledge_entries import KnowledgeEntry
from flow_sdk.builtin.knowledge_base.Knowledge_types import KnowledgeEntryType
from .knowledge_engine.ontology import Ontology


class KnowledgeItem(BaseModel):
    """A content-carrying item in the legacy (v1) knowledge index.

    Formerly the ``FSItem`` entity; decoupled into a plain KB-local value so the
    filesystem listing type (now ``FSEntry``) and the persisted file entity
    (``File``) do not have to double as a knowledge item. Carries only what the
    v1 retrieval path reads: a typeid and text content.
    """

    typeid: TypeId
    content: str = ""


class ItemKeyed(BaseModel):
    item_typeid: TypeId


class KeyedKeywords(ItemKeyed):
    keywords: list[str]


class KeyedEmbeddings(ItemKeyed):
    embedding: list[float]


class KnowledgeData(BaseModel):
    # Legacy fields for backward compatibility (version 1)
    items: dict[TypeId, KnowledgeItem] = Field(default_factory=dict)
    keyed_embeddings: list[KeyedEmbeddings] = Field(default_factory=list)

    # New fields (version 2)
    name: Optional[str] = None
    description: Optional[str] = None
    _ontology: Optional[Ontology] = PrivateAttr(default=None)
    entries: List[KnowledgeEntry] = Field(default_factory=list)
    pack_version: Optional[str] = None

    def __init__(self, **data):
        # Handle ontology field if provided
        ontology = data.pop("ontology", None)
        # Remove legacy field if present
        data.pop("entry_instruction", None)
        super().__init__(**data)
        if ontology:
            # Ensure ontology is always an Ontology object, not a dict
            if isinstance(ontology, dict):
                self._ontology = Ontology.model_validate(ontology)
            elif isinstance(ontology, Ontology):
                self._ontology = ontology
            else:
                logging.warning(f"Unexpected ontology type in __init__: {type(ontology)}")
                self._ontology = None

    @model_validator(mode="before")
    @classmethod
    def validate_ontology_and_entries(cls, data):
        """Handle ontology and entries deserialization."""
        if isinstance(data, dict):
            # Handle ontology deserialization
            if "ontology" in data:
                ontology_data = data["ontology"]
                if isinstance(ontology_data, dict):
                    data["ontology"] = Ontology.model_validate(ontology_data)
                elif not isinstance(ontology_data, Ontology):
                    logging.warning(f"Unexpected ontology type: {type(ontology_data)}")

            # Handle entries deserialization
            if "entries" in data and isinstance(data["entries"], list):
                processed_entries = []
                for entry_data in data["entries"]:
                    if isinstance(entry_data, dict):
                        processed_entries.append(KnowledgeEntry.model_validate(entry_data))
                    else:
                        processed_entries.append(entry_data)
                data["entries"] = processed_entries

        return data

    @property
    def ontology(self) -> Optional[Ontology]:
        """Read-only access to the ontology."""
        return self._ontology

    def load_ontology(self, new_ontology: Ontology) -> None:
        """
        Load and merge a new ontology into the existing one.
        If no ontology exists, set it as the current ontology.
        If an ontology exists, merge the new one, with new labels overwriting duplicates.
        """
        if new_ontology is None:
            return

        if self._ontology is None:
            self._ontology = new_ontology
            logging.info(f"Loaded new ontology with {len(new_ontology.labels)} labels")
        else:
            self._ontology.merge(new_ontology, warn_on_duplicates=True)

    @model_serializer(mode="wrap")
    def knowledge_data_serializer(self, nxt):
        data = nxt(self)
        # ``KnowledgeItem.content`` is a real field, so default serialization
        # already carries it — no special-casing needed (it used to be a
        # property on the FSItem entity that the dump would otherwise drop).

        if self.entries:
            data["entries"] = [entry.model_dump() for entry in self.entries]

        if self._ontology:
            data["ontology"] = self._ontology.model_dump()
        return data

    def invalidate(self, entry_id: str):
        """Invalidate a specific entry by ID."""
        found = False
        for entry in self.entries:
            if entry.id == entry_id:
                entry.invalidate()
                found = True
        return found

    def get_entries_by_labels(self, label_ids: List[str]) -> List[KnowledgeEntry]:
        """
        Fetch entries that match ANY of the provided label keywords (last segment of label).
        Returns only valid entries.
        """
        matches = []
        for entry in self.entries:
            if not entry.valid:
                continue
            for label in entry.labels:
                label_segment = label.split(".")[-1]
                if label_segment in label_ids:
                    matches.append(entry)
                    break
        return matches

    def _match_label_pattern(self, pattern: str, label: str) -> bool:
        """Check if a label matches a glob pattern."""
        return fnmatch.fnmatch(label, pattern)

    def get_instructions(self, labels: List[str], strict: bool = False) -> List[KnowledgeEntry]:
        """
        Get all instruction entries that match the provided labels with glob pattern support.
        """
        if not labels:
            return []

        universal_instructions = []
        partial_matches = []
        full_matches = []

        for i, entry in enumerate(self.entries):
            if not entry.valid or entry.entry_type != KnowledgeEntryType.INSTRUCTION:
                continue

            if "*" in entry.labels:
                universal_instructions.append((i, entry))
                continue

            if strict:
                if set(entry.labels) == set(labels):
                    full_matches.append((i, entry))
            else:
                matched = True
                for entry_label in entry.labels:
                    if not any(self._match_label_pattern(pattern, entry_label) for pattern in labels):
                        matched = False
                        break

                if matched:
                    match_count = sum(
                        1
                        for pattern in labels
                        if any(self._match_label_pattern(pattern, entry_label) for entry_label in entry.labels)
                    )
                    partial_matches.append((match_count, i, entry))

        result = []
        universal_instructions.sort(key=lambda x: x[0])
        result.extend([entry for _, entry in universal_instructions])
        partial_matches.sort(key=lambda x: (x[0], x[1]))
        result.extend([entry for _, _, entry in partial_matches])
        full_matches.sort(key=lambda x: x[0])
        result.extend([entry for _, entry in full_matches])

        return result

    def neural_query(self, embedding: List[float], top_k: int = 5) -> List[KnowledgeEntry]:
        """
        Returns top_k valid entries by max cosine similarity between entry embeddings and query embedding.
        """
        def cosine_sim(a, b):
            a, b = np.array(a), np.array(b)
            return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

        scored = []
        for entry in self.entries:
            if not entry.valid or not entry.embeddings:
                continue
            best_sim = max(cosine_sim(embedding, emb) for emb in entry.embeddings)
            scored.append((best_sim, entry))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [entry for sim, entry in scored[:top_k]]

    def __add__(self, other):
        # Merge two KnowledgeData objects
        new_ontology = None
        if self.ontology or other.ontology:
            new_ontology = Ontology()
            if self.ontology:
                new_ontology.merge(self.ontology, warn_on_duplicates=False)
            if other.ontology:
                new_ontology.merge(other.ontology, warn_on_duplicates=True)

        entries_dict = {e.id: deepcopy(e) for e in self.entries}
        for e in other.entries:
            entries_dict[e.id] = deepcopy(e)

        merged_items = {**self.items, **other.items}
        merged_embeddings = self.keyed_embeddings + other.keyed_embeddings

        result = KnowledgeData(
            name=f"{self.name or 'data'}_{other.name or 'data'}_merged",
            description=f"Merged: {self.description or ''} | {other.description or ''}",
            entries=list(entries_dict.values()),
            items=merged_items,
            keyed_embeddings=merged_embeddings,
        )
        if new_ontology:
            result._ontology = new_ontology
        return result

    def merge(self, other: "KnowledgeData") -> "KnowledgeData":
        """
        Merge another KnowledgeData into this one using the + operator.
        """
        return self + other
