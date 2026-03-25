"""Semantic analysis for extracting keywords and generating plans from user prompts."""

import json
import logging
import re
from typing import List, Optional

from pydantic import BaseModel, Field

from flow_sdk.builtin.artifact import ArtifactType
from flow_sdk.builtin.knowledge_base import KnowledgeData
from flow_sdk.external_apis.llm.simple_llm import llm_completion
from flow_sdk.knowledge_engine.ontology import Ontology


class UserPromptAnalysis(BaseModel):
    """Semantic context extracted from user input."""

    user_prompt: Optional[str] = Field(None, description="Original user prompt")
    goal: str
    keywords: List[str] = Field(default_factory=list, description="Keywords extracted from the user prompt")
    labels: List[str] = Field(default_factory=list, description="Semantic labels matching ontology")
    expected_result_types: List[ArtifactType] = Field(
        default_factory=list, description="Expected artifact types from the prompt"
    )
    simple_answer: bool = Field(default=True, description="Whether the prompt requires a simple answer (True/False)")


def _extract_pattern_keywords(prompt: str) -> List[str]:
    """Extract keywords using simple pattern matching."""
    # Simple word extraction with basic filtering
    words = re.findall(r"\b\w+\b", prompt.lower())

    # Filter out common stop words and short words
    stop_words = {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "has",
        "he",
        "in",
        "is",
        "it",
        "its",
        "of",
        "on",
        "that",
        "the",
        "to",
        "was",
        "were",
        "will",
        "with",
        "the",
        "this",
        "but",
        "they",
        "have",
        "had",
        "what",
        "said",
        "each",
        "which",
        "she",
        "do",
        "how",
        "their",
        "if",
        "up",
        "out",
        "many",
        "then",
        "them",
        "these",
        "so",
        "some",
        "her",
        "would",
        "make",
        "like",
        "into",
        "him",
        "time",
        "two",
        "more",
        "very",
        "when",
        "come",
        "may",
        "see",
        "use",
        "no",
        "way",
        "could",
    }

    keywords = [word for word in words if len(word) > 2 and word not in stop_words]

    # Remove duplicates while preserving order
    return list(dict.fromkeys(keywords))


class SemanticAnalyzer:
    """Analyzes user prompts to extract semantic context for instruction matching."""

    def __init__(self, model: str = "openai/gpt-4o-mini"):
        self.model = model

    async def extract_prompt_context(
        self, user_prompt: str, knowledge_data: Optional["KnowledgeData"] = None
    ) -> UserPromptAnalysis:
        """Extract goal, keywords, and expected result types from user prompt."""
        if knowledge_data is None or knowledge_data.ontology is None:
            return await self._analyze_prompt(user_prompt)
        return await self._analyze_prompt(user_prompt, knowledge_data.ontology)

    async def extract_labels(self, prompt: str, ontology: Optional["Ontology"] = None) -> List[str]:
        # in the future we can use cheaper/faster ways to extract labels
        context = await self._analyze_prompt(prompt, ontology)
        return context.labels

    async def _analyze_prompt(self, prompt: str, ontology: Optional["Ontology"] = None) -> UserPromptAnalysis:
        """Analyze user prompt to extract comprehensive context including labels, goal, keywords, and expected result types."""

        # Extract basic keywords using pattern matching
        keywords = _extract_pattern_keywords(prompt)

        if ontology and ontology.labels:
            # Build ontology context with keyword and description
            ontology_entries = []
            available_label_ids = []
            for label_info in ontology.labels.values():
                label_id = label_info.label  # Last segment of the label
                description = label_info.description or "No description available"
                ontology_entries.append(f"{label_id}: {description}")
                available_label_ids.append(label_id)
            ontology_context = "\n".join(ontology_entries[:100])  # Limit to 100 for prompt length
        else:
            ontology_context = "No ontology labels available."
            available_label_ids = []

        # Build result types context
        result_types = [rt.value for rt in ArtifactType]
        result_types_str = ", ".join(result_types)

        instruction = f"""Analyze the user request and return a JSON response with the following structure:
{{
    "labels": ["label1", "label2", ...],
    "goal_summary": "7-word summary of the user's goal",
    "expected_result_type": "result_type_or_null",
    "simple_answer": "True/False"
}}

Requirements:
1. labels: Extract 3-5 semantic labels that match EXACTLY the available ontology labels (case-sensitive). These will be used to fetch detailed instructions.
2. goal_summary: Exactly 7 words that capture the essence of the user's request
3. expected_result_type: ONE of the valid ArtifactType values ({result_types_str}), or null if no specific result is expected
4. simple_answer: "True/False" # Simple response does not require actions on machine like shell, file, api calls

Available ontology labels (choose the most relevant ones):
{ontology_context}

User request: "{prompt}"

Return valid JSON only."""

        try:
            result = await llm_completion(instruction, prompt, model=self.model)

            # Parse JSON response
            analysis_data = json.loads(result.strip())

            # Extract labels with the same post-processing as before
            extracted_keywords = analysis_data.get("labels", [])

            # Clean up extracted keywords - if LLM returns "label: description", extract just the label
            cleaned_keywords = []
            for keyword in extracted_keywords:
                # Check if the keyword contains a colon (indicating "label: description" format)
                if ":" in keyword:
                    # Extract just the label ID part (before the colon)
                    label_part = keyword.split(":")[0].strip()
                    cleaned_keywords.append(label_part)
                else:
                    cleaned_keywords.append(keyword.strip())

            # Remove duplicates while preserving order
            cleaned_keywords = list(dict.fromkeys(cleaned_keywords))

            # Filter to only include exact matches from ontology
            valid_keywords = []
            for label_id in cleaned_keywords:
                if label_id in available_label_ids:
                    valid_keywords.append(label_id)
                else:
                    logging.debug(f"Keyword '{label_id}' not found in ontology, skipping")

            if not valid_keywords:
                logging.warning(f"No ontology keywords found in extracted keywords: {extracted_keywords}")
            else:
                logging.info(f"Found {len(valid_keywords)} valid ontology keywords: {valid_keywords}")

            valid_labels = valid_keywords[:5]  # Limit to 5

            # Extract and validate result type
            result_type_str = analysis_data.get("expected_result_type")
            expected_result_types = []
            if result_type_str and result_type_str != "null":
                try:
                    result_type = ArtifactType(result_type_str)
                    expected_result_types = [result_type]
                except ValueError:
                    logging.warning(f"Invalid artifact type from LLM: {result_type_str}")

            # Extract goal summary (7 words)
            goal_summary = analysis_data.get("goal_summary", "").strip()
            if not goal_summary or len(goal_summary.split()) != 7:
                # Fallback: create 7-word summary from original prompt
                words = prompt.strip().split()[:7]
                if len(words) >= 7:
                    goal_summary = " ".join(words[:7])
                else:
                    # If less than 7 words, use the full prompt
                    goal_summary = prompt.strip()
            simple_answer = analysis_data.get("simple_answer", "").strip()
            simple_answer = "true" in simple_answer.lower()
            return UserPromptAnalysis(
                user_prompt=prompt.strip(),
                goal=goal_summary,
                labels=valid_labels,
                keywords=keywords,
                expected_result_types=expected_result_types,
                simple_answer=simple_answer,
            )

        except (json.JSONDecodeError, KeyError, Exception) as e:
            logging.error(f"Error in prompt analysis: {e}")
            # Fallback to basic analysis
            return UserPromptAnalysis(
                user_prompt=prompt.strip(), goal=prompt.strip(), labels=[], keywords=keywords, expected_result_types=[]
            )
