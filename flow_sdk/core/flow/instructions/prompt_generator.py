"""Generate agent instructions using the TemplateEngine."""

from pathlib import Path

from flow_sdk import service_log
from flow_sdk.template_engine import TemplateEngine

from .instruction_context import InstructionContext
from .skill_manager import generate_skill_catalog

_engine: TemplateEngine | None = None

TEMPLATES_DIR = Path(__file__).resolve().parent.parent.parent.parent / "template_engine" / "templates"
ROOT_TEMPLATE = "solution_engineer"


def _get_engine() -> TemplateEngine:
    global _engine
    if _engine is None:
        _engine = TemplateEngine()
        _engine.load_folder(TEMPLATES_DIR)
    return _engine


async def generate_built_in_instructions(context: InstructionContext) -> str:
    """Generate and return the built-in instructions for FlowPad AI agents."""
    service_log.info("generate_built_in_instructions")

    engine = _get_engine()
    context_dict = await context.get_initial_instruction_context([])
    instructions = engine.generate(ROOT_TEMPLATE, context_dict)

    if context.enable_skills and context.skills_folder:
        skill_catalog = generate_skill_catalog(context.skills_folder)
        if skill_catalog:
            instructions = f"{instructions}\n\n{skill_catalog}"

    return instructions
