"""Request classification for ongoing conversation requests."""

import logging
from dataclasses import dataclass

from flow_sdk.core.flow.models.state.flow_state import FlowMode
from flow_sdk.external_apis.llm.simple_llm import llm_completion

JSON_FIELD_MODE = "mode"
JSON_FIELD_LABELS = "labels"

REQUEST_CLASSIFICATION_PROMPT = """## Request Classification

Analyze the user's request and classify the mode.
Output ONLY a valid JSON object with the classification results.

### Output Format:
Return a JSON object with exactly these two fields:
{{{{
  "{json_field_mode}": "{mode_ask}" or "{mode_agent}",
  "{json_field_labels}": []
}}}}

### Mode Classification:
- **{mode_ask}**: Questions requiring answers, casual conversation, or information gathering
  Examples: "What is X?", "How does Y work?", "Tell me about Z", "Explain..."

- **{mode_agent}**: Directives requiring action, task execution, or work to be done
  Examples: "Build X", "Fix Y", "Deploy Z", "Create...", "Implement..."

### Decision Guidelines:
- Questions (what/how/why/when/where) → "{mode_ask}"
- Imperative verbs (create/build/fix/deploy/implement/migrate) → "{mode_agent}"
- Requests for help/explanation/information → "{mode_ask}"
- Commands to perform work/tasks → "{mode_agent}"

### Labels:
- Use labels to capture key topics, technologies, libraries, services, or concepts mentioned in the request.
- Should be empty if no relevant labels.

**CRITICAL - Output Requirements:**
- Return ONLY valid JSON (no markdown, no explanations, no extra text)
- Mode must be exactly "{mode_ask}" or "{mode_agent}" (capitalized)
- Do not wrap in code blocks or add any additional text
"""


@dataclass
class RequestClassification:
    """Classification result from LLM analysis of user request."""

    mode: FlowMode
    labels: list[str]


async def classify_request(user_prompt: str, context: str = "") -> RequestClassification:
    """Classify mode in a single LLM request using JSON mode."""
    try:
        instruction = REQUEST_CLASSIFICATION_PROMPT.format(
            mode_ask=FlowMode.ASK.value,
            mode_agent=FlowMode.AGENT.value,
            json_field_mode=JSON_FIELD_MODE,
            json_field_labels=JSON_FIELD_LABELS,
        )

        if context:
            instruction = f"{instruction}\n\n### Additional Context:\n{context}\n"

        user_content = f"User request: {user_prompt}"

        data = await llm_completion(
            instruction=instruction,
            content=user_content,
            model="openai/gpt-4o",
            json_reply=True,
            reasoning=True,
        )

        if not isinstance(data, dict):
            logging.warning(f"Expected dict from json_reply, got {type(data)}: {data}")
            return RequestClassification(mode=FlowMode.UNKNOWN, labels=[])

        mode_str = data.get(JSON_FIELD_MODE, "").strip().lower()
        if mode_str == FlowMode.ASK.value.lower():
            mode = FlowMode.ASK
        elif mode_str == FlowMode.AGENT.value.lower():
            mode = FlowMode.AGENT
        else:
            logging.warning(f"Unknown mode classification: {mode_str}. Defaulting to UNKNOWN")
            mode = FlowMode.UNKNOWN

        labels = data.get(JSON_FIELD_LABELS, [])
        if not isinstance(labels, list):
            logging.warning(f"Expected list for labels, got {type(labels)}: {labels}")
            labels = []

        result = RequestClassification(mode=mode, labels=labels)
        logging.info(f"Classified: mode={result.mode.value}, labels={result.labels}")
        return result

    except Exception as e:
        logging.exception(f"Error classifying request: {e}")
        return RequestClassification(mode=FlowMode.UNKNOWN, labels=[])
