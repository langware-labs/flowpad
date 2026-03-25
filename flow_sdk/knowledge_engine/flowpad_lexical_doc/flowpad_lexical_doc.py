"""
FlowpadLexicalDoc - A specialized LexicalDoc with FlowPad-specific functionality.

This class extends the base LexicalDoc with label sections and knowledge management features.
Ontology should be passed as a parameter when needed, not stored in the document.
"""

from typing import Any, Dict, List, Optional, Union

from flow_sdk.external_apis.lexical_doc import LexicalDoc, LexicalRoot
from flow_sdk.knowledge_engine.label import LabelSection


class FlowpadLexicalDoc(LexicalDoc):
    """
    A specialized LexicalDoc with FlowPad-specific functionality.

    Extends the base LexicalDoc to include:
    - Label sections management from label-heading nodes
    - Dynamic extraction of structured content

    Note: This is NOT an entity and does not store ontology.
    Ontology should be obtained from the containing entity (e.g., Page)
    and passed as a parameter when needed.
    """

    def __init__(self, content: Optional[Union[str, Dict, LexicalRoot]] = None, **data):
        """
        Initialize FlowpadLexicalDoc.

        Args:
            content: Initial content (same as LexicalDoc)
        """
        super().__init__(content, **data)

    @classmethod
    def from_lexical_doc(cls, lexical_doc: LexicalDoc) -> "FlowpadLexicalDoc":
        """Create FlowpadLexicalDoc from an existing LexicalDoc."""
        return cls(root=lexical_doc.root.copy())

    @property
    def label_sections(self) -> List[LabelSection]:
        """Dynamically extract label sections from the lexical JSON structure."""
        if not self.root or "root" not in self.root or "children" not in self.root["root"]:
            return []

        label_sections = []
        current_section = None
        current_content = []

        for child in self.root["root"]["children"]:
            if child.get("type") == "label-heading":
                # Save previous section if exists
                if current_section:
                    content_text = self._extract_text_from_nodes(current_content)
                    current_section.content = content_text
                    label_sections.append(current_section)

                # Create new section from label-heading
                heading_text = self._extract_text_from_node(child)
                labels = child.get("labels", [])

                if labels:
                    # Use the first label or create one from the heading text
                    label = labels[0] if labels else heading_text.lower().replace(" ", "_")
                else:
                    label = heading_text.lower().replace(" ", "_")

                current_section = LabelSection(
                    label=label,
                    title=heading_text,
                    content="",
                    metadata={"labels": labels, "tag": child.get("tag", "h3")},
                )
                current_content = []
            else:
                # Collect content for current section
                if current_section:
                    current_content.append(child)

        # Save last section
        if current_section:
            content_text = self._extract_text_from_nodes(current_content)
            current_section.content = content_text
            label_sections.append(current_section)

        return label_sections

    def __repr__(self) -> str:
        """Developer-friendly representation."""
        num_children = len(self.children)
        num_sections = len(self.label_sections)
        return f"FlowpadLexicalDoc(children={num_children}, sections={num_sections})"

    def _extract_text_from_node(self, node: Any) -> str:
        """Extract text content from a single lexical node."""
        if isinstance(node, dict) and node.get("type") == "text":
            return node.get("text", "")
        elif isinstance(node, dict) and "children" in node:
            texts = []
            for child in node["children"]:
                texts.append(self._extract_text_from_node(child))
            return "".join(texts)
        return ""

    def _extract_text_from_nodes(self, nodes: List[Any]) -> str:
        """Extract text content from a list of lexical nodes."""
        texts = []
        for node in nodes:
            text = self._extract_text_from_node(node)
            if text.strip():
                texts.append(text)
        return "\n".join(texts)

    def add_label_heading(self, text: str, labels: List[str], tag: str = "h3") -> "FlowpadLexicalDoc":
        """Add a label-heading node to the lexical content."""
        from flow_sdk.external_apis.lexical_doc.utils import create_text_node

        label_heading: Dict[str, Any] = {
            "children": [create_text_node(text)],
            "direction": "ltr",
            "format": "",
            "indent": 0,
            "type": "label-heading",
            "version": 1,
            "labels": labels,
            "tag": tag,
        }

        self.root["root"]["children"].append(label_heading)  # type: ignore
        return self

    def add_label_section(self, section: LabelSection) -> "FlowpadLexicalDoc":
        """Add a label section to the document by adding a label-heading node."""
        labels = section.metadata.get("labels", [section.label])
        tag = section.metadata.get("tag", "h3")
        self.add_label_heading(section.title, labels, tag)

        # Add content if present
        if section.content.strip():
            self.add_paragraph(section.content)

        return self

    def get_label_headings(self) -> List[Dict[str, Any]]:
        """Get all label-heading nodes from the lexical content."""
        if not self.root or "root" not in self.root:
            return []

        label_headings = []
        for child in self.root["root"]["children"]:
            if child.get("type") == "label-heading":
                label_headings.append(child)

        return label_headings

    def update_label_heading_labels(self, heading_text: str, new_labels: List[str]) -> "FlowpadLexicalDoc":
        """Update the labels for a specific label-heading node."""
        for child in self.root["root"]["children"]:
            if child.get("type") == "label-heading":
                current_text = self._extract_text_from_node(child)
                if current_text == heading_text:
                    child["labels"] = new_labels
                    break

        return self
