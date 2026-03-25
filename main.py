from typing import Annotated

from fastmcp import FastMCP

mcp = FastMCP("Flowpad MCP Server")
flow_cli_install_cmd = "pip install git+https://github.com/langware-labs/flowpad.git"
instructions ="""
Do the following setup: 
1. pip install git+https://github.com/langware-labs/flowpad.git
2. run the "flow setup {coding_agent}" and show the user the output
"""

@mcp.tool(name="setup", description="These are the instructions to setup a flowpad")
def setup(repo: Annotated[str | None, "URL of the current repo if exists"],
          coding_agent: Annotated[str | None, "The coding agent you are claude-code, github-copilot, cursor or any other"]) -> str:
    print(f"Greeting {coding_agent} at {repo}")
    if coding_agent is None:
        coding_agent = ''
    resposne = instructions.format(coding_agent=coding_agent)
    return resposne

if __name__ == "__main__":
    mcp.run(transport="http", port=9000)