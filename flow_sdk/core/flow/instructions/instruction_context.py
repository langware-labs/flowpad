from typing import Any, Dict, List, Optional

from flow_sdk.builtin.agent_config import AgentConfig
from flow_sdk.builtin.process import CompletionRequest
from flow_sdk.builtin.knowledge_base.knowledge_data import KnowledgeData
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.user import User
from flow_sdk.core.entity.entity_env.env_table import merge_env_tables
from flow_sdk.core.entity.entity_env.env_types import EntityEnvVars, EnvVar
from flow_sdk.core.flow.instructions.prompts.result import allowed_artifact_table, allowed_artifact_types_csv
from flow_sdk.core.flow.mcp_server import MCPConnector
from flow_sdk.core.flow.tools import SearchMode
from flow_sdk.core.oauth import get_available_oauth_providers, get_oauth_providers_as_env_table
from flow_sdk.external_apis.search.web_search import DEFAULT_SEARCH_NUM_RESULTS


async def get_env_vars_table_string(
    user: Optional[User],
    project: Optional[Project],
    env_vars: Optional[List[EnvVar]] = None,
) -> str:
    if user and project:
        user_table = user.env_vars if user.env_vars else EntityEnvVars[EnvVar]()
        project_table = project.env_vars if project.env_vars else EntityEnvVars[EnvVar]()
        env_vars_status_table = merge_env_tables(project_table, user_table, base_entity_typeid=project.typeid)
        return env_vars_status_table.to_string()
    else:
        # Fallback to simple env vars list if user/project not available
        env_vars_table = EntityEnvVars[EnvVar](values=env_vars or [])
        return env_vars_table.to_string()


async def get_oauth_connections_table_string(user: Optional[User]) -> str:
    if user:
        user_env_table = user.get_env_table()
        oauth_providers_table = await get_oauth_providers_as_env_table()
        connection_status_table = merge_env_tables(oauth_providers_table, user_env_table)
        return connection_status_table.to_string()
    else:
        return ""


class InstructionContext:
    """
    Manages and builds instruction templates for AI agents.
    """

    def __init__(
        self,
        mcp_connector: MCPConnector | None,
        user_request: CompletionRequest,
        agent_name: str = "FlowpadAI",
        env_vars: Optional[List[EnvVar]] = None,
        user: Optional[User] = None,
        project: Optional[Project] = None,
        user_instructions: Optional[str] = None,
        enable_search: bool = False,
        agent_config: AgentConfig | None = None,
        knowledge_instructions: Optional[KnowledgeData] = None,
        knowledge_instructions_str: Optional[str] = None,
        skills_folder: Optional[str] = None,
        enable_skills: bool = False,
    ):
        self.agent_name = agent_name
        self.env_vars = env_vars or []
        self.user = user
        self.project = project
        self.user_instructions = user_instructions
        self.enable_search = enable_search
        self.knowledge_instructions = knowledge_instructions
        self.knowledge_instructions_str = knowledge_instructions_str

        self.user_request = user_request
        self.mcp_connector = mcp_connector
        self.agent_config = agent_config
        self.skills_folder = skills_folder
        self.enable_skills = enable_skills

    async def get_initial_instruction_context(self, required_params_names: List[str]) -> Dict[str, Any]:
        # Prepare env_vars data for pybars template
        context_dict = {}

        # Get environment variables table
        context_dict["env_vars_table"] = await get_env_vars_table_string(
            user=self.user,
            project=self.project,
            env_vars=self.env_vars,
        )

        # Get OAuth connections status table
        context_dict["oauth_connections_table"] = await get_oauth_connections_table_string(user=self.user)

        oauth_providers_info = await get_available_oauth_providers()
        oauth_provider_names = [provider.name for provider in oauth_providers_info]
        context_dict["oauth_provider_names"] = "\n".join(oauth_provider_names)

        # Prepare user files data for pybars template
        if self.user_request and self.user_request.uploaded_file_paths:
            user_files_list = "\n".join(self.user_request.uploaded_file_paths)
        else:
            user_files_list = ""

        # Prepare file system state from MCP connector
        fs_mcp_state = None
        fs_state_command = None
        git_branch = None
        if self.mcp_connector:
            try:
                git_branch = self.mcp_connector.source_control.get_branch()
            except Exception:
                pass

            if "fs_mcp_state" in required_params_names:
                try:
                    fs_output = await self.mcp_connector.source_control.get_current_fs_state()
                    fs_cmd = self.mcp_connector.source_control.fs_state_command
                    if fs_output and fs_cmd:
                        fs_mcp_state = fs_output
                        fs_state_command = fs_cmd
                except Exception:
                    # If MCP fails, leave fs_mcp_state as None
                    pass
        context_dict["fs_mcp_state"] = fs_mcp_state
        context_dict["fs_state_command"] = fs_state_command
        context_dict["git_branch"] = git_branch
        # Prepare search-related context variables
        search_enabled = self.enable_search
        is_fast_mode = True  # Default to fast mode
        num_results = "5"  # Default number of results

        if self.agent_config and self.agent_config.search:
            search_mode = self.agent_config.search.search_mode
            is_fast_mode = search_mode == SearchMode.FAST
            num_results = str(self.agent_config.search.num_results or DEFAULT_SEARCH_NUM_RESULTS)

        # Add the remaining context variables to context_dict
        context_dict.update(
            {
                "agent_name": self.agent_name,
                "max_test_attempts": "10",
                "tests_per_item": "2",
                "user_files_list": user_files_list,
                "user_instructions": self.user_instructions or "",
                "knowledge_instructions": self.knowledge_instructions_str or "",
                "enable_search": search_enabled,
                "is_fast_mode": is_fast_mode,
                "num_results": num_results,
                "allowed_artifact_table": allowed_artifact_table,
                "allowed_artifact_types_csv": allowed_artifact_types_csv,
            }
        )

        return context_dict
