import logging
import json
from typing import ClassVar, List, Optional, Type

from pydantic import field_validator

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.knowledge_base import KnowledgeData, KnowledgeEntry, KnowledgeEntryType
from flow_sdk.core import Entity, QueryFilter
from flow_sdk.db.db_entity import DBEntityType
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.db.drivers.query import ExpressionNode, QueryOp
from .external_apis.lexical_doc import LexicalRoot, empty_lexical_root, lexical_to_markdown
from .external_apis.llm import LLMMessage
from .knowledge_engine.flowpad_lexical_doc import FlowpadLexicalDoc
from .knowledge_engine.ontology import Ontology


class Page(Entity):
    type: str = APIField(default=BuiltinEntityType.PAGE.value)
    title: str = APIField("")
    version: str = APIField(None)
    raw_content: Optional[str] = APIField(None, blob=True)
    template_id: Optional[str] = APIField(None)
    tags: List[str] = APIField([])
    _api_visible: ClassVar[bool] = True

    @property
    def lexical_content(self) -> LexicalRoot:
        if not self.raw_content:
            return empty_lexical_root
        return json.loads(self.raw_content)

    @property
    def markdown_content(self) -> str:
        if not self.raw_content:
            return ""
        return lexical_to_markdown(dict(self.lexical_content))

    @property
    def llm_message(self) -> LLMMessage:
        return LLMMessage(role="user", content=self.markdown_content)

    # TODO, check this valdiation error message on decorator
    # noinspection PyNestedDecorators
    @field_validator("raw_content", mode="before")
    @classmethod
    def validate_raw_content(cls, v: Optional[str]) -> Optional[str]:
        if isinstance(v, dict):
            raw_content = json.dumps(v)
            return raw_content
        if v:
            try:
                json.loads(v)
            except json.JSONDecodeError:
                raise ValueError("Invalid JSON content")
        return v

    @classmethod
    async def get_all(
        cls: Type[DBEntityType],
        entities_filter: QueryFilter | dict | None = None,
        source_entity: TypeId | None = None,
    ) -> List[DBEntityType]:
        if isinstance(entities_filter, dict):
            entities_filter = QueryFilter.parse(entities_filter, cls.get_type())
        entities_filter = entities_filter or QueryFilter(type=cls.get_type())
        entities_filter.expand_is_private = True
        _all = await super().get_all(entities_filter=entities_filter, source_entity=source_entity)
        return _all

    @classmethod
    async def get_template(cls, template_title: str) -> Optional["Page"]:
        return await Page.get_one(
            QueryFilter(
                match=ExpressionNode(
                    op=QueryOp.AND,
                    operands=[
                        ExpressionNode(
                            op=QueryOp.IN, operands=["template", ExpressionNode(op=QueryOp.PROP, operands=["tags"])]
                        ),
                        ExpressionNode(op=QueryOp.EQ, operands=["title", template_title]),
                    ],
                )
            )
        )

    async def get_ontology(self) -> Optional[Ontology]:
        """
        Get the ontology from the nearest KnowledgeBase ancestor.

        Returns None if no KnowledgeBase ancestor is found or if it has no ontology.
        """
        from flow_sdk.builtin.knowledge_base import KnowledgeBase
        from flow_sdk.core import QueryFilter

        # Get all parent entities in the path
        parents = await self.get_parents_path()

        # Find the first KnowledgeBase in the parent path
        for parent in parents:
            if parent.type == KnowledgeBase.get_type():
                # Ensure we have a KnowledgeBase instance
                if not isinstance(parent, KnowledgeBase):
                    kb = await KnowledgeBase.get_one(QueryFilter(match=ExpressionNode(id=parent.id)))
                else:
                    kb = parent

                if kb and kb.has_blob_fields():
                    await kb.expand_blobs()

                # Get knowledge data and extract ontology
                if kb and kb.knowledge_data:
                    kd = kb.get_knowledge_data()
                    if kd and kd.ontology:
                        return kd.ontology

        return None

    async def gen_kbp(self) -> KnowledgeData:
        """Generate knowledge data from this page.

        This method ensures blobs are expanded before processing the page content
        to generate structured knowledge data entries from the FlowpadLexicalDoc content.
        """
        # Ensure blob fields (like raw_content) are loaded, but only if raw_content is not already available
        if not self.raw_content and self.has_blob_fields():
            await self.expand_blobs()

        knowledge_data = KnowledgeData(version=2)

        # Parse the FlowpadLexicalDoc from page content
        # Check if the content is the extended format with sections
        entries = []
        ontology = None

        if self.raw_content:
            try:
                content_data = json.loads(self.raw_content)
                if isinstance(content_data, dict) and "sections" in content_data:
                    # This is the extended format with sections
                    sections = content_data.get("sections", [])
                    ontology_data = content_data.get("ontology", {})

                    # Create entries from sections
                    for section_data in sections:
                        entry = KnowledgeEntry(
                            id=f"{section_data['label']}_{hash(section_data['content']) % 10000}",
                            labels=[section_data["label"]],
                            content=section_data["content"],
                            content_type="text",
                            entry_type=KnowledgeEntryType.INSTRUCTION,
                        )
                        entries.append(entry)

                    # Reconstruct ontology if available
                    if ontology_data:
                        ontology = Ontology()
                        for label_info in ontology_data.get("labels", []):
                            from .knowledge_engine.ontology import LabelInfo

                            ontology.add_label(LabelInfo(**label_info))
                else:
                    # Fallback to parsing as regular FlowpadLexicalDoc
                    # The content_data is already parsed JSON
                    doc = FlowpadLexicalDoc(content=content_data)
                    if doc.label_sections:
                        for section in doc.label_sections:
                            entry = KnowledgeEntry(
                                id=f"{section.label}_{hash(section.content) % 10000}",
                                labels=[section.label],
                                content=section.content,
                                content_type="text",
                                entry_type=KnowledgeEntryType.INSTRUCTION,
                            )
                            entries.append(entry)
            except json.JSONDecodeError:
                # If it's not valid JSON, skip
                pass

        knowledge_data.entries = entries
        knowledge_data.load_ontology(ontology)

        return knowledge_data
