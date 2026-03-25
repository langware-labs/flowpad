"""
LabelManager class for managing label operations and organization.
"""

from collections import defaultdict
from typing import Dict, List, Optional

from flow_sdk.knowledge_engine.ontology import LabelInfo, Ontology

from .label_section import LabelSection


class LabelManager:
    """Manages label operations, organization, and section creation."""

    def __init__(self, ontology: Optional[Ontology] = None):
        """Initialize with an optional ontology."""
        self.ontology = ontology or Ontology()

    def create_sections_from_labels(
        self, labels: List[str], content_map: Optional[Dict[str, str]] = None
    ) -> List[LabelSection]:
        """Create a hierarchical list of LabelSections from a list of labels."""
        content_map = content_map or {}
        sections_by_label = {}

        # Sort labels by depth (number of segments) to process parents first
        sorted_labels = sorted(labels, key=lambda x: len(x.split(".")))

        for label in sorted_labels:
            content = content_map.get(label, "")
            label_info = self.ontology.find_label(label)

            if label_info:
                section = LabelSection.from_label_info(label_info, content)
            else:
                # Create a basic section if label not in ontology
                section = LabelSection(label=label, content=content)

            sections_by_label[label] = section

            # Find parent and add as subsection
            parent_label = self._get_parent_label(label)
            if parent_label and parent_label in sections_by_label:
                sections_by_label[parent_label].add_subsection(section)

        # Return only root sections (those without parents in the list)
        root_sections = []
        for label in sorted_labels:
            parent_label = self._get_parent_label(label)
            if not parent_label or parent_label not in sections_by_label:
                root_sections.append(sections_by_label[label])

        return root_sections

    def organize_sections_by_priority(self, sections: List[LabelSection]) -> List[LabelSection]:
        """Sort sections by priority (descending) and then by label alphabetically."""
        return sorted(sections, key=lambda x: (-x.priority, x.label))

    def group_sections_by_keyword(self, sections: List[LabelSection]) -> Dict[str, List[LabelSection]]:
        """Group sections by their keyword (last segment of label)."""
        groups = defaultdict(list)
        for section in sections:
            groups[section.keyword].append(section)
        return dict(groups)

    def filter_sections_by_labels(self, sections: List[LabelSection], filter_labels: List[str]) -> List[LabelSection]:
        """Filter sections to only include those with labels in the filter list."""
        filter_set = set(filter_labels)
        filtered = []

        def should_include(section: LabelSection) -> bool:
            # Include if section label is in filter
            if section.label in filter_set:
                return True
            # Include if any parent label is in filter
            parts = section.label.split(".")
            for i in range(len(parts)):
                parent = ".".join(parts[: i + 1])
                if parent in filter_set:
                    return True
            return False

        for section in sections:
            if should_include(section):
                filtered.append(section)

        return filtered

    def get_sections_with_content(self, sections: List[LabelSection]) -> List[LabelSection]:
        """Filter sections to only include those with non-empty content."""
        result = []
        for section in sections:
            if section.content.strip():
                result.append(section)
            # Also check subsections
            subsections_with_content = self.get_sections_with_content(section.subsections)
            result.extend(subsections_with_content)
        return result

    def merge_sections(self, sections1: List[LabelSection], sections2: List[LabelSection]) -> List[LabelSection]:
        """Merge two lists of sections, combining content for matching labels."""
        merged_by_label = {}

        # Add sections from first list
        for section in sections1:
            merged_by_label[section.label] = section

        # Merge or add sections from second list
        for section in sections2:
            if section.label in merged_by_label:
                # Merge content
                existing = merged_by_label[section.label]
                if section.content and section.content not in existing.content:
                    existing.content += f"\n\n{section.content}"
                # Merge metadata
                existing.metadata.update(section.metadata)
                # Merge subsections recursively
                existing.subsections = self.merge_sections(existing.subsections, section.subsections)
            else:
                merged_by_label[section.label] = section

        return list(merged_by_label.values())

    def find_related_sections(self, section: LabelSection, all_sections: List[LabelSection]) -> List[LabelSection]:
        """Find sections that are related to the given section (share common label prefixes)."""
        related = []
        section_parts = section.label.split(".")

        for other_section in all_sections:
            if other_section.label == section.label:
                continue

            other_parts = other_section.label.split(".")

            # Check if they share a common prefix
            common_length = 0
            for i in range(min(len(section_parts), len(other_parts))):
                if section_parts[i] == other_parts[i]:
                    common_length += 1
                else:
                    break

            # Consider related if they share at least one common segment
            if common_length > 0:
                related.append(other_section)

        return related

    def _get_parent_label(self, label: str) -> Optional[str]:
        """Get the parent label for a given label."""
        parts = label.split(".")
        if len(parts) <= 1:
            return None
        return ".".join(parts[:-1])

    def add_label_to_ontology(self, label: str, description: Optional[str] = None, color: Optional[str] = None) -> bool:
        """Add a label to the ontology."""
        label_info = LabelInfo(label=label, description=description, color=color)
        return self.ontology.add_label(label_info)

    def get_section_statistics(self, sections: List[LabelSection]) -> Dict[str, int]:
        """Get statistics about the sections."""
        stats = {
            "total_sections": 0,
            "sections_with_content": 0,
            "total_content_length": 0,
            "max_depth": 0,
            "unique_keywords": 0,
        }

        all_sections = []
        for section in sections:
            all_sections.extend(section.flatten())

        keywords = set()
        for section in all_sections:
            stats["total_sections"] += 1
            if section.content.strip():
                stats["sections_with_content"] += 1
            stats["total_content_length"] += len(section.content)
            stats["max_depth"] = max(stats["max_depth"], section.depth)
            keywords.add(section.keyword)

        stats["unique_keywords"] = len(keywords)
        return stats
