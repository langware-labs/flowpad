from pathlib import Path
from typing import Annotated, Literal

from fastmcp import Context
from mcp_auth import create_mcp_server
from pydantic import Field

# Create an MCP server
mcp = create_mcp_server("TextEditorMCP")

# Store edit history for undo functionality
edit_history = {}


@mcp.tool(
    name="str_replace_editor",
    description="Text editor tool that can view, create, and modify files",
    tags={"editor", "file", "text"},
)
async def str_replace_editor(
    ctx: Context,
    command: Annotated[
        Literal["view", "str_replace", "create", "insert", "undo_edit"], Field(description="The command to execute")
    ],
    path: Annotated[str, Field(description="Path to the file or directory")],
    view_range: Annotated[
        list[int] | None,
        Field(description="Range of lines to view [start, end], 1-indexed. Use -1 for end to read to end of file"),
    ] = None,
    old_str: Annotated[str | None, Field(description="The text to replace (for str_replace command)")] = None,
    new_str: Annotated[
        str | None, Field(description="The new text to insert (for str_replace or insert commands)")
    ] = None,
    file_text: Annotated[str | None, Field(description="Content for the new file (for create command)")] = None,
    insert_line: Annotated[
        int | None,
        Field(description="Line number after which to insert text (for insert command), 0 for beginning of file"),
    ] = None,
) -> str:
    """
    Text editor tool that supports several commands for viewing and modifying files:

    - view: Examine file contents or list directory contents
    - str_replace: Replace specific text in a file
    - create: Create a new file with specified content
    - insert: Insert text at a specific location in a file
    - undo_edit: Revert the last edit made to a file
    """
    await ctx.info(f"Executing {command} command on path: {path}")
    p = Path(path)

    try:
        # VIEW command
        if command == "view":
            if p.is_dir():
                # List directory contents
                contents = [x for x in p.iterdir()]
                await ctx.info(f"Listed directory with {len(contents)} entries")
                return "\n".join([f"{'[DIR]' if x.is_dir() else '[FILE]'} {x.name}" for x in contents])
            elif p.is_file():
                # Read file contents
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    lines = f.readlines()

                # Handle view_range if provided
                if view_range:
                    start = max(0, view_range[0] - 1)  # Convert to 0-indexed
                    end = view_range[1] if view_range[1] != -1 else len(lines)
                    lines = lines[start:end]

                content = "".join(lines)
                await ctx.info(f"Viewed file with {len(lines)} lines")
                return content
            else:
                await ctx.error(f"Path does not exist: {path}")
                return f"Path does not exist: {path}"

        # STR_REPLACE command
        elif command == "str_replace":
            if not p.is_file():
                await ctx.error(f"File does not exist: {path}")
                return f"File does not exist: {path}"

            if old_str is None or new_str is None:
                await ctx.error("str_replace requires both old_str and new_str parameters")
                return "str_replace requires both old_str and new_str parameters"

            # Read file content
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()

            # Check if old_str exists in the file
            if old_str not in content:
                await ctx.error(f"Could not find the specified text to replace in {path}")
                return f"Could not find the specified text to replace in {path}"

            # Save backup for undo
            if path not in edit_history:
                edit_history[path] = []
            edit_history[path].append(content)

            # Perform replacement
            new_content = content.replace(old_str, new_str)

            # Write updated content
            with open(path, "w", encoding="utf-8") as f:
                f.write(new_content)

            await ctx.info(f"Replaced text in {path}")
            return f"Successfully replaced text in {path}"

        # CREATE command
        elif command == "create":
            if file_text is None:
                await ctx.error("create command requires file_text parameter")
                return "create command requires file_text parameter"

            # Ensure directory exists
            p.parent.mkdir(parents=True, exist_ok=True)

            # Create file
            with open(path, "w", encoding="utf-8") as f:
                f.write(file_text)

            await ctx.info(f"Created new file: {path}")
            return f"Successfully created file: {path}"

        # INSERT command
        elif command == "insert":
            if not p.is_file():
                await ctx.error(f"File does not exist: {path}")
                return f"File does not exist: {path}"

            if insert_line is None or new_str is None:
                await ctx.error("insert command requires insert_line and new_str parameters")
                return "insert command requires insert_line and new_str parameters"

            # Read file content
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()

            # Save backup for undo
            if path not in edit_history:
                edit_history[path] = []
            edit_history[path].append("".join(lines))

            # Ensure line number is valid
            insert_pos = max(0, min(insert_line, len(lines)))

            # Add newline if necessary
            if new_str and not new_str.endswith("\n"):
                new_str += "\n"

            # Insert the new text
            lines.insert(insert_pos, new_str)

            # Write updated content
            with open(path, "w", encoding="utf-8") as f:
                f.writelines(lines)

            await ctx.info(f"Inserted text at line {insert_line} in {path}")
            return f"Successfully inserted text at line {insert_line} in {path}"

        # UNDO_EDIT command
        elif command == "undo_edit":
            if not p.is_file():
                await ctx.error(f"File does not exist: {path}")
                return f"File does not exist: {path}"

            if path not in edit_history or not edit_history[path]:
                await ctx.error(f"No edit history found for {path}")
                return "No edit history found for this file"

            # Get the previous state
            previous_content = edit_history[path].pop()

            # Restore the file
            with open(path, "w", encoding="utf-8") as f:
                f.write(previous_content)

            await ctx.info(f"Undid last edit to {path}")
            return f"Successfully undid last edit to {path}"

    except Exception as e:
        await ctx.error(f"Error in str_replace_editor: {str(e)}")
        return f"Error: {str(e)}"
