"""End-to-end test: Workflow.run() executes a workflow and produces output files.

Steps:
  1. Create a workflow markdown file with "create hello_world.txt" instruction.
  2. Instantiate a Workflow entity pointing to that file (no DB save needed).
  3. Call workflow.run() — saves an AgenticProcessRecord canonically so
     record.output_dir is the deterministic output folder, then launches Claude
     (no HTTP API calls, uses the Claude CLI directly).
  4. Wait for the process to complete.
  5. Assert process.output_folder (= record.output_dir) contains hello_world.txt.

Requires:
  - DEEP_TESTING=true  (or 1 / yes)
  - `claude` CLI in PATH and network access
"""

import tempfile
from pathlib import Path

import pytest
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
]

from flow_sdk.builtin.workflow import Workflow


@pytest.mark.asyncio
# do not increase timeout without approval
@pytest.mark.timeout(30)
async def test_workflow_run_creates_hello_world():
    """workflow.run() executes workflow content; output_folder contains hello_world.txt."""

    # 1. Create a temporary workflow markdown file
    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".md",
        prefix="test_workflow_",
        delete=False,
        encoding="utf-8",
    ) as f:
        f.write("Create a file named hello_world.txt with the content 'Hello World'.\n")
        workflow_path = Path(f.name)

    try:
        # 2. Build a Workflow entity pointing at the temp file (no DB save required)
        # asset_ref is stored without the leading "/" (VFS convention)
        workflow = Workflow(asset_ref=str(workflow_path).lstrip("/"))

        # 3. Run the workflow — saves record canonically, launches Claude CLI directly
        process = await workflow.run()

        # 4. Wait for the process to complete
        # do not increase timeout without approval
        await process.waitForIdle(timeout=28)

        # 5. output_folder is record.output_dir — granted by the Record system
        output_folder = process.output_folder
        assert output_folder is not None, "process.output_folder must be set"

        output_files = list(output_folder.rglob("*"))
        output_names = {f.name for f in output_files if f.is_file()}
        assert "hello_world.txt" in output_names, (
            f"hello_world.txt not found in output_folder ({output_folder}).\n"
            f"Files found: {sorted(output_names) or '[none]'}"
        )

        # 6. Validate file content
        content = (output_folder / "hello_world.txt").read_text(encoding="utf-8")
        assert "hello" in content.lower(), (
            f"Expected 'hello' in file content, got: {content!r}"
        )

    finally:
        workflow_path.unlink(missing_ok=True)
