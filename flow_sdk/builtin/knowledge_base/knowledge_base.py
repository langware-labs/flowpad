import asyncio
import base64
import binascii
import gzip
import json
from typing import ClassVar

import numpy as np
from fastapi import UploadFile
from fastapi.responses import StreamingResponse
from usearch.index import Index

from flow_sdk.config import default_service_config
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.fs_entities import FSItem
from flow_sdk.builtin.knowledge_base.knowledge_data import KeyedEmbeddings, KnowledgeData
from flow_sdk.core import action
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiSuccessResponse
from .external_apis.embeddings.embeddings_connector import generate_embeddings
from .knowledge_engine.ontology import LabelInfo, Ontology
from flow_sdk.utils import count_tokens


class OntologyManager:
    """Manager for ontology operations on a knowledge base."""

    def __init__(self, knowledge_base: "KnowledgeBase"):
        self._kb = knowledge_base

    @property
    def data(self) -> Ontology | None:
        """Get the actual ontology data (read-only)."""
        return self._kb.knowledge_data.ontology

    def load_ontology(self, ontology: Ontology) -> None:
        """
        Load an ontology into the knowledge base, merging with existing ontology.
        If two keys exist, the loaded ontology overwrites the existing key/value.

        Args:
            ontology: The ontology to load and merge
        """
        if not self._kb.knowledge_data.ontology:
            # If no existing ontology, load it using the standard method
            self._kb.knowledge_data.load_ontology(ontology)
        else:
            # Merge with existing ontology (loaded overwrites existing)
            self._kb.knowledge_data.ontology.merge(ontology)

        # Update raw_knowledge to persist the changes
        self._kb.raw_knowledge = self._kb.knowledge_data.model_dump_json()

    def add_label(self, label_info: LabelInfo) -> bool:
        """Add a label to the ontology. Returns True if added, False if already exists."""
        if not self._kb.knowledge_data.ontology:
            # Create empty ontology and load it
            empty_ontology = Ontology()
            self._kb.knowledge_data.load_ontology(empty_ontology)

        result = self._kb.knowledge_data.ontology.add_label(label_info)
        if result:
            self._kb.raw_knowledge = self._kb.knowledge_data.model_dump_json()
        return result

    def remove_label(self, label_id: str) -> bool:
        """Remove a label from the ontology. Returns True if removed, False if not found."""
        if not self.data:
            return False
        result = self.data.remove_label(label_id)
        if result:
            self._kb.raw_knowledge = self._kb.knowledge_data.model_dump_json()
        return result

    def update_label(self, label: str, description: str | None = None, color: str | None = None) -> bool:
        """Update a label in the ontology. Returns True if updated, False if not found."""
        if not self.data:
            return False

        label_info = self.data.find_label(label)
        if label_info:
            if description is not None:
                label_info.description = description
            if color is not None:
                label_info.color = color
            self._kb.raw_knowledge = self._kb.knowledge_data.model_dump_json()
            return True
        return False

    def get_labels(self) -> list[LabelInfo]:
        """Get all labels from the ontology."""
        if not self.data:
            return []
        return list(self.data.labels.values())

    def find_label(self, label: str) -> LabelInfo | None:
        """Find a label by its label string."""
        if not self.data:
            return None
        return self.data.find_label(label)

    def __len__(self) -> int:
        """Return the number of labels in the ontology."""
        if not self.data:
            return 0
        return len(self.data.labels)

    def __iter__(self):
        """Allow iteration over labels."""
        if not self.data:
            return iter([])
        return iter(self.data.labels.values())

    def __bool__(self) -> bool:
        """Check if ontology exists and has labels."""
        return self.data is not None and len(self.data.labels) > 0


async def _apply_token_budget(results: list[tuple[FSItem, float]], token_budget: int):
    # First, compute the approximate total tokens of the results using binary search
    left = 0
    right = len(results)
    while left < right:
        mid = (left + right) // 2
        approximate_mid_tokens = (
            sum(len(item[0].content) for item in results[:mid])
            / default_service_config.knowledge_default_characters_per_token
        )
        if approximate_mid_tokens > token_budget:
            right = mid
        else:
            left = mid + 1
    cutoff = left
    # Then, validate the cutoff
    total_tokens = await count_tokens([item[0].content for item in results[:cutoff]])
    if total_tokens < token_budget:
        # If the total tokens are less than the token budget
        while total_tokens < token_budget and cutoff <= len(results):
            cutoff += 1
            total_tokens = await count_tokens([item[0].content for item in results[:cutoff]])
        return results[: cutoff - 1]
    else:
        # If the total tokens are greater than the token budget
        while total_tokens > token_budget and cutoff > 0:
            cutoff -= 1
            total_tokens = await count_tokens([item[0].content for item in results[:cutoff]])
        return results[:cutoff]


class KnowledgeBase(Entity):
    type: str = APIField(default="knowledge_base")
    name: str | None = APIField(default="Knowledge Base")
    description: str | None = APIField(default=None)
    _index: Index | None = None
    _knowledge_data: KnowledgeData | None = None
    raw_knowledge: str | None = APIField(default=None, blob=True)
    # TODO Enable async invalidation of items
    # invalidated_items: list[TypeId] = []
    _api_visible: ClassVar[bool] = True

    def __init__(self, **data):
        super().__init__(**data)
        if not self.exist_in_db and not self.raw_knowledge:
            self._knowledge_data = KnowledgeData(items={}, keyed_embeddings=[])
            self.raw_knowledge = self._knowledge_data.model_dump_json()

    @property
    def knowledge_data(self) -> KnowledgeData:
        if self._knowledge_data is None:
            if not self.raw_knowledge:
                # Initialize with empty knowledge data if raw_knowledge is not available
                self._knowledge_data = KnowledgeData(items={}, keyed_embeddings=[])
                self.raw_knowledge = self._knowledge_data.model_dump_json()
            else:
                self._knowledge_data = KnowledgeData.model_validate(json.loads(self.raw_knowledge))
        return self._knowledge_data

    @knowledge_data.setter
    def knowledge_data(self, knowledge_data: KnowledgeData):
        self._knowledge_data = knowledge_data
        self.raw_knowledge = self.knowledge_data.model_dump_json()

    def compile_instructions(self) -> None:
        """
        Compile all instruction entries in the knowledge data and update the blob.
        This should be called before saving the KnowledgeBase entity.
        """
        self.knowledge_data.compile_instructions()
        # Update the blob by setting knowledge_data (triggers setter)
        self.knowledge_data = self._knowledge_data

    def validate_compilation(self) -> bool:
        """
        Validate compilation hashes for all instruction entries.

        Returns:
            bool: True if all instruction entries have valid hashes
        """
        return self.knowledge_data.validate_compilation()

    @property
    def fs_items(self):
        return list(self.knowledge_data.items.values())

    @property
    def ontology(self) -> "OntologyManager":
        """Get ontology manager for knowledge data."""
        return OntologyManager(self)

    @property
    def index(self) -> Index | None:
        return self._index

    @index.setter
    def index(self, index: Index):
        self._index = index

    async def query_knowledge(self, query_string: str, token_budget: int):
        if self.index is None:
            raise ValueError("Index is not built. Please build the index first.")
        # query_keywords = await get_top_words(query_string)
        query_embedding = np.array((await generate_embeddings([query_string]))[0], dtype=np.float32)

        neighbors = await asyncio.to_thread(
            self.index.search, query_embedding, count=default_service_config.knowledge_default_num_of_results
        )
        vector_search_results = [
            (int(key), float(distance)) for key, distance in zip(neighbors.keys, neighbors.distances)
        ]
        results = [
            (self.knowledge_data.items[self.knowledge_data.keyed_embeddings[key].item_typeid], distance)
            for key, distance in vector_search_results
        ]
        return await _apply_token_budget(results, token_budget)

    async def invalidate_items(self, items: list[FSItem]):
        await self._remove_items([item.typeid for item in items if item.typeid in self.knowledge_data.items])
        await self._add_items_to_knowledge(items)
        await self._build_index_from_items()

    async def remove_items(self, item_typeids: list[TypeId]):
        await self._remove_items(item_typeids)
        await self._build_index_from_items()

    async def _remove_items(
        self,
        item_typeids: list[TypeId],
    ):
        for item_typeid in item_typeids:
            if item_typeid in self.knowledge_data.items:
                del self.knowledge_data.items[item_typeid]
                self.knowledge_data.keyed_embeddings = [
                    keyed_embedding
                    for keyed_embedding in self.knowledge_data.keyed_embeddings
                    if keyed_embedding.item_typeid != item_typeid
                ]

        self.raw_knowledge = self.knowledge_data.model_dump_json()

    async def add_items_to_knowledge(self, items: list[FSItem]):
        await self._add_items_to_knowledge(items)
        await self._build_index_from_items()

    async def _add_items_to_knowledge(self, items: list[FSItem]):
        contents = [item.content for item in items]
        # keywords = [await get_top_words(content) for content in contents]
        embeddings = await generate_embeddings(contents)
        for embedding, item in zip(embeddings, items):
            self.knowledge_data.items[item.typeid] = item
            self.knowledge_data.keyed_embeddings.append(KeyedEmbeddings(item_typeid=item.typeid, embedding=embedding))

        self.raw_knowledge = self.knowledge_data.model_dump_json()

    async def validate_index(self):
        if not self.index:
            await self._build_index_from_items()

    async def _build_index_from_items(self):
        if self.index:
            # Reset the index if it already exists to avoid duplicate memory usage
            await asyncio.to_thread(self.index.reset)
        index = Index(dtype=np.float32, ndim=default_service_config.vector_dimensions)
        if len(self.knowledge_data.keyed_embeddings) == 0:
            # If there are no items, set an empty index
            self.index = index
            return
        ids = np.arange(len(self.knowledge_data.keyed_embeddings))
        embeddings = np.array(
            [keyed_embedding.embedding for keyed_embedding in self.knowledge_data.keyed_embeddings], dtype=np.float32
        )
        await asyncio.to_thread(index.add, keys=ids, vectors=embeddings)
        self.index = index

    @staticmethod
    def from_knowledge_bases(knowledge_bases: list["KnowledgeBase"]):
        # If no knowledge bases are provided, return an empty knowledge base
        if len(knowledge_bases) == 0:
            return KnowledgeBase()
        # If only one knowledge base is provided, return it
        if len(knowledge_bases) == 1:
            return knowledge_bases[0]
        # Merge the knowledge bases
        knowledge_data = knowledge_bases[0].knowledge_data
        for knowledge_base in knowledge_bases[1:]:
            knowledge_data += knowledge_base.knowledge_data
        new_knowledge_base = KnowledgeBase()
        new_knowledge_base.knowledge_data = knowledge_data
        return new_knowledge_base

    def __add__(self, other):
        self.knowledge_data = self.knowledge_data + other.knowledge_data
        self.raw_knowledge = self.knowledge_data.model_dump_json()
        return self

    def to_file(self, file_path: str):
        # Save the knowledge base to a file
        if not self.raw_knowledge:
            raise ValueError("raw_knowledge is empty. Expand blobs first.")
        with open(file_path, "w") as f:
            f.write(self.raw_knowledge)

    @classmethod
    def from_file(cls, file_path: str):
        # Load the knowledge base from a file
        with open(file_path, "r") as f:
            raw_knowledge = f.read()
        return cls(raw_knowledge=raw_knowledge)

    @classmethod
    async def decode_data(cls, knowledge_bin_str: str) -> KnowledgeData:
        if not knowledge_bin_str.strip():
            raise ValueError("raw_knowledge cannot be empty or whitespace only")
        try:
            # First, try to decompress the gzip data (expecting base64 encoded gzip)
            compressed_data = base64.b64decode(knowledge_bin_str)
            decompressed_data = gzip.decompress(compressed_data)
            json_str = decompressed_data.decode("utf-8")
        except (binascii.Error, gzip.BadGzipFile):
            # If decompression fails, treat as uncompressed JSON data
            json_str = knowledge_bin_str

        try:
            # Parse and validate the JSON data
            knowledge_data_json = json.loads(json_str)
            knowledge_data = KnowledgeData.model_validate(knowledge_data_json)
            return knowledge_data
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON format in data: {e}")
        except Exception as e:
            raise ValueError(f"Invalid knowledge data format: {e}")

    @classmethod
    @action.all(methods="post")
    async def upload(cls, knowledge_file: UploadFile):
        request_info = get_current_request_info()
        if not request_info:
            raise ValueError("No request context found.")

        if not request_info.auth_result or not request_info.auth_result.target:
            raise ValueError("No target_entity found in request")

        target_entity = request_info.auth_result.target
        file_data = await knowledge_file.read()
        knowledge_data: KnowledgeData = await cls.decode_data(file_data.decode("utf-8"))

        # Create new knowledge base instance
        knowledge_base = cls()
        knowledge_base.knowledge_data = knowledge_data

        # Set knowledge base name based on uploaded file
        if knowledge_file.filename:
            knowledge_base.name = knowledge_file.filename

        # Save the knowledge base as a child of the agent
        await knowledge_base.save()
        await target_entity.add_dependency(knowledge_base)
        await target_entity.add_child(knowledge_base)

        return ApiSuccessResponse[TypeId](data=knowledge_base.typeid)

    async def encoded_data(self) -> str:
        """Return the raw_knowledge as a base64 encoded string."""
        if not self.raw_knowledge:
            return ""
        # Validate that the raw_knowledge is valid JSON
        try:
            json.loads(self.raw_knowledge)
        except json.JSONDecodeError:
            raise ValueError("raw_knowledge contains invalid JSON data.")

        # Compress with gzip and encode as base64
        compressed_data = gzip.compress(self.raw_knowledge.encode("utf-8"))
        encoded_data = base64.b64encode(compressed_data).decode("ascii")
        return encoded_data

    @action.all(methods="get")
    async def download(self):
        await self.expand_blobs()

        encoded_data = await self.encoded_data()

        def generate_chunks():
            chunk_size = 8192
            for i in range(0, len(encoded_data), chunk_size):
                chunk = encoded_data[i : i + chunk_size]
                yield chunk

        return StreamingResponse(
            content=generate_chunks(),
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f'attachment; filename="flowpad_knowledge_base_{self.id}.kbp"',
                "Content-Length": str(len(encoded_data)),
            },
        )

    def add_label(self, label: LabelInfo | str) -> bool:
        """Add a label to the knowledge base ontology. Returns True if added, False if already exists."""
        if isinstance(label, str):
            label_info = LabelInfo(label=label)
        else:
            label_info = label
        return self.ontology.add_label(label_info)

    def remove_label(self, label: str) -> bool:
        """Remove a label from the knowledge base ontology. Returns True if removed, False if not found."""
        return self.ontology.remove_label(label)

    def update_label(self, label: str, description: str | None = None, color: str | None = None) -> bool:
        """Update a label in the knowledge base ontology. Returns True if updated, False if not found."""
        return self.ontology.update_label(label, description=description, color=color)

    def get_labels(self) -> list[LabelInfo]:
        """Get all labels from the knowledge base ontology."""
        return self.ontology.get_labels()

    @action.all(methods="get")
    async def view(self):
        await self.expand_blobs()
        items = list(self.knowledge_data.items.values())
        return ApiSuccessResponse[list[FSItem]](data=items)
