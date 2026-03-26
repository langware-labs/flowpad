import importlib
import importlib.util
import inspect
import logging
import os
import sys
import traceback
from enum import Enum
from flow_sdk._compat import StrEnum
from pathlib import Path
from typing import Any, Callable, ClassVar, Dict, List, Optional, Union, get_type_hints

from pydantic import BaseModel, Field
from starlette.requests import Request

from flow_sdk.config import default_service_config
from flow_sdk.api.api_types.api_field import APIField, JSONType, NoDbBField
from flow_sdk.api.type_id import TypeId
from flow_sdk.core import RequestInfo, action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.request_context.methods import get_current_request_info, get_current_sod_store
from flow_sdk.core.responses import ApiFailResponse, ApiResponse, ApiSuccessResponse
from .external_apis.sod import SodDriver
from flow_sdk.utils import (
    ROOT_FOLDER,
    cwd_as_root_folder,
    fetch_json,
    fetch_url,
    get_manifest_folder,
    validate_schema_on_data,
)


class ExecutionEnvironment(str, Enum):
    SERVER = "server"
    CLIENT = "client"


class FunctionCapability(str, Enum):
    UNKNOWN = "unknown"
    WEBHOOK = "webhook"
    WEBHOOK_KEYS_MAPPING = "webhook_keys_mapping"
    WEB_COMPONENT = "web-component"
    TEST = "test"
    OAUTH = "oauth"
    PYTHON_SCRIPT = "python-script"
    ACTION = "action"
    JOB = "job"
    REACT_COMPONENT = "react-component"


class FuncDescriptor(BaseModel):
    name: str
    title: str
    description: str


class Func(BaseModel):
    name: Optional[str] = Field(description="The name of the function", default=None)
    title: Optional[str] = Field(description="The title of the function", default=None)
    description: Optional[str] = Field(description="A brief description of the function", default=None)
    entry_point: Optional[str] = Field(description="The function exe entry point", default=None)
    # Execution Environment
    executor: Optional[ExecutionEnvironment] = Field(default=None)
    # Core Function Type
    capability: FunctionCapability = Field(description="The primary capability this function provides")
    capability_config: Any = Field(description="Configuration for the capability", default_factory=dict)
    # Schema Information
    input_schema: Union[str, Dict[str, Any]] = Field(description="Input schema definition", default_factory=dict)
    output_schema: Union[str, Dict[str, Any]] = Field(description="Output schema definition", default_factory=dict)
    _api_visible: ClassVar[bool] = True

    async def get_input_schema(self) -> Dict[str, Any]:
        if isinstance(self.input_schema, str):
            self.input_schema = await fetch_json(self.input_schema)
        return self.input_schema

    @property
    def descriptor(self):
        return FuncDescriptor(
            name=self.name or self.title or "", title=self.title or self.name or "", description=self.description or ""
        )

    @action.all()
    async def install(self):
        if self.executor == ExecutionEnvironment.CLIENT:
            return

        if self.capability == FunctionCapability.ACTION:
            # return await self.install_internal_action()
            # TODO, DO NOT INSTALL ACTION, this is security matter.
            return
        # elif self.capability == FunctionCapability.JOB:
        #     return await self.install_job_action()
        elif self.capability == FunctionCapability.PYTHON_SCRIPT:
            return
        else:
            raise ValueError("This method currently supports only Python scripts executed on the server.")

    async def install_internal_action(self):
        request_info = get_current_request_info()

        async def internal_action_handler(request: Request):
            request_json = await request_info.get_post_data()
            return await self.run(func_input=request_json)

        if not self.title:
            raise ValueError("Action title not found")
        existing = action.get_by_name(self.title)
        if existing:
            raise ValueError(f"Action '{self.title}' already exists, cannot install")
        action.register(
            action_name=self.title,
            function_name=self.title,
            handler=internal_action_handler,
        )

    # async def install_job_action(self):
    #     # get the function runner and create the function
    #     job_runner = get_job_runner()
    #     # pass either one
    #     str_code = self.capability_config.get("str_code")
    #
    #     # TODO: implement FSItem after Eran merges the PR
    #     # fs_item = FSItem.get_one({"id": self.environment.environment_info["fs_item_id"]})
    #     external_function_id = await job_runner.create(str_code)
    #
    #     # register the function to the action module
    #     async def job_action_handler(request: Request):
    #         func_input = await request_info.get_post_data()
    #         func_input["external_function_id"] = external_function_id
    #         return await self.run(func_input=func_input)
    #
    #     action_name = self.capability_config.get("action_name")  # will be "counter"
    #     action.register(
    #         action_name=action_name,
    #         function_name=self.title,
    #         handler=job_action_handler,
    #     )
    #
    #     response = ApiSuccessResponse(data={"external_function_id": external_function_id}, message="Function installed")
    #     return response

    # action.register(action_name, functools.partial(self.run, external_function_id=external_function_id))

    async def get_output_schema(self) -> Dict[str, Any]:
        if isinstance(self.output_schema, str):
            self.output_schema = await fetch_json(self.output_schema)
        return self.output_schema

    async def run(
        self,
        func_input: Dict[str, Any] | None = None,
    ) -> Any:
        if self.executor == ExecutionEnvironment.CLIENT:
            # Client function execution happens in the client on the streamed input of the function
            return

        # Server function
        if func_input is None:
            func_input = {}
        validate_schema_on_data(await self.get_input_schema(), func_input, log_errors=True)

        if self.capability == FunctionCapability.ACTION:
            func_output = await self.run_action(func_input)
        elif self.capability == FunctionCapability.JOB:
            func_output = await self.run_job_action(func_input)
        elif self.capability == FunctionCapability.PYTHON_SCRIPT:
            func_output = await self.run_python(func_input)
        else:
            raise ValueError("This method currently supports only Python scripts executed on the server.")

        func_output_dict = func_output
        if isinstance(func_output, BaseModel):
            func_output_dict = func_output.model_dump()
        validate_schema_on_data(await self.get_output_schema(), func_output_dict, log_errors=True)
        return func_output

    async def run_python(
        self,
        func_input: Dict[str, Any],
    ) -> Any:
        # TODO this is a temporary solution to be able to pass complex objects to the function.
        #  Should probably use entity pointers for complex input and websocket instead of stream
        # Load the Python script as a string
        if not isinstance(self.capability_config, str):
            raise ValueError("The 'capability_config' field of a python-script function environment must be a string")
        with cwd_as_root_folder():
            if os.path.exists(self.capability_config):
                script_content = await fetch_url(self.capability_config)
            else:
                raise FileNotFoundError(f"Python script not found at {self.capability_config}")
        # Prepare the environment for the script
        exec_locals = {
            **func_input,
            # Here would be the place to add any additional variables that all scripts might need
        }
        exec_globals = {
            "__file__": self.capability_config,
            "__builtins__": __builtins__,
        }
        # Execute the script: exec(script_content, globals, locals)
        root_path_folder = Path(ROOT_FOLDER)
        compiled_script = compile(script_content, root_path_folder / self.capability_config, "exec")
        exec(compiled_script, exec_globals, exec_locals)
        # Get the output data from the script
        script_main: Optional[Callable] = exec_locals.get("main", None)
        if script_main is None:
            raise RuntimeError("Script does not contain a 'main' function")
        # Make sure all the necessary variables are available to the script
        # noinspection PyUnresolvedReferences
        script_main.__globals__.update(exec_locals)
        # Run the script
        if inspect.iscoroutinefunction(script_main):
            output_data = await script_main(**func_input)
        else:
            output_data = script_main(**func_input)
        return output_data

    # TODO remove this method
    async def run_action(self, func_input: Dict[str, Any]) -> Any:
        a = action.get_by_name(self.capability_config)
        if not a:
            raise ValueError(f"Action '{self.capability_config}' not found")
        # Currently, only no-args action handlers are supported
        if inspect.iscoroutinefunction(a.handler):
            response: ApiResponse = await a.handler(**func_input)
        else:
            response: ApiResponse = a.handler(**func_input)
        # Consider returning the response as is
        return response.data

    # TODO remove this method
    # noinspection PyMethodMayBeStatic
    async def run_job_action(self, func_input: Dict[str, Any]):
        try:
            external_function_id = func_input.pop("external_function_id")
        except KeyError:
            raise ValueError("External function id is required for job action")
        # pass jwt to runner
        # runner = get_job_runner()
        # job = await runner.run(external_function_id, **func_input)
        # TODO: return job_id or job_typeid
        # if not job:
        return ApiSuccessResponse(data={"job_typeid": f"{external_function_id}:1234"})
        # return {"job_typeid": job.typeid}

    def __repr__(self):
        return self.name or self.title or "Func"


class SyncOperation(str, Enum):
    PULL = "pull"
    PUSH = "push"
    PUSH_PULL = "push_pull"


class SyncMode(str, Enum):
    MANUAL = "manual"
    POLLING = "polling"
    WEBHOOK = "webhook"


class PluginInstallScope(StrEnum):
    User = "user"
    Workspace = "workspace"


class SyncService(BaseModel):
    title: str = Field(description="The title of the sync service")
    sync_operation: SyncOperation = Field(description="The sync operation performed by the service")
    sync_mode: SyncMode = Field(description="The sync mode of the service")
    entity_type: str = Field(description="The entity type to sync")
    reflection_type: str = Field(description="The reflection entity type to sync")
    func_title: str = Field(description="The title of the function that performs the sync")

    # noinspection PyMethodMayBeStatic
    async def get_func(self) -> Optional[Func]:
        return None  # TODO, Not supported
        # return await Func.get_one({"title": self.func_title})


# class PluginStatus(str, Enum):
#     ACTIVE = "active"
#     INACTIVE = "inactive"
#     ERROR = "error"
class PluginVersion(BaseModel):
    name: str
    version: str


class PluginCredentials(BaseModel):
    value: Optional[Any] = None


class OAuthCredentials(PluginCredentials):
    @property
    def access_token(self) -> str:
        if isinstance(self.value, str):
            return self.value
        raise ValueError("OAuth access token is not a string")


class PluginResponse(BaseModel):
    value: Optional[Any] = None


class PluginManifest(Entity):
    type: str = APIField(default=BuiltinEntityType.PLUGIN_MANIFEST.value)
    name: str = APIField()
    version: str = APIField()
    title: Optional[str] = APIField(None)
    description: Optional[str] = APIField(None)
    icon: Optional[str] = APIField(None)
    dependencies: Optional[List[PluginVersion]] = APIField(None)
    category: str | None = APIField(description="The category of the plugin", default=None)
    base_url: str = APIField(default=None)
    latest: bool = APIField(default=False)
    funcs: List[Func] = APIField(description="The functions that the plugin provides", default=[])
    fpplugin_path_cache: ClassVar[Dict[str, str]] = {}
    _api_visible: ClassVar[bool] = True
    _unique: ClassVar[List[str]] = ["name"]

    @classmethod
    async def get_by_name(cls, name: str) -> Optional["PluginManifest"]:
        return await cls.get_one({"name": name})

    @classmethod
    async def from_fpplugin(cls, fpplugin_path: str) -> "PluginManifest":
        manifest = await fetch_json(fpplugin_path)
        if not manifest:
            raise FileNotFoundError(f"Plugin manifest not found at {fpplugin_path}")
        return cls(**manifest)

    @action.all()
    async def install(self):
        # go over functions and sync services and install them
        for func in self.funcs:
            await func.install()

    async def create_plugin(self, parent: TypeId | None = None) -> "Plugin":
        plugin = Plugin(name=self.name, version=self.version, install_target=parent)
        await plugin.save(parent)
        return plugin

    @property
    def manifest_json_path(self):
        return self.fpplugin_path_cache.get(self.name, None)

    @property
    def manifest_json(self):
        if not self.manifest_json_path:
            return None
        return fetch_json(self.manifest_json_path)

    @property
    def manifest_folder(self):
        if not self.manifest_json_path:
            return None
        return os.path.dirname(self.manifest_json_path)

    def get_func_by_name(self, func_name: str) -> Optional[Func]:
        for func in self.funcs:
            if func.name == func_name:
                return func
        return None

    def get_func_by_title(self, func_title: str) -> Optional[Func]:
        for func in self.funcs:
            if func.title == func_title:
                return func
        return None

    # noinspection PyMethodMayBeStatic
    def get_function_from_module(self, module: Any, func_name: str) -> Callable[..., Any] | None:
        for name in dir(module):
            if name == func_name:  # Ignore built-in attributes
                value = getattr(module, name)
                if isinstance(value, Callable):
                    return value
        return None

    def get_entry_module(self, entry_module: str):
        if entry_module.endswith(".py"):
            entry_module = entry_module[:-3]
        module_name = f"func_dynamic_{self.name}_{entry_module}"
        if module_name in sys.modules:
            return sys.modules[module_name]
        module_path = os.path.join(self.manifest_folder or "", f"{entry_module}.py")
        if not os.path.exists(module_path):
            raise FileNotFoundError(f"Entry file not found for: {entry_module}, plugin: {self.name}")

        try:
            spec = importlib.util.spec_from_file_location(module_name, module_path)
            if not spec or not spec.loader:
                raise ImportError(f"Cannot find module '{module_name}'")
            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            spec.loader.exec_module(module)
            return sys.modules[module_name]

        except Exception as e:
            logging.error(f"Error loading module '{module_name}': {e}")
            if default_service_config.development:
                logging.error(traceback.format_exc())
            raise

    async def get_function_object(self, func_name: str) -> Callable[..., Any] | None:
        func: Func | None = self.get_func_by_name(func_name)
        if not func or not func.name:
            raise NotImplementedError(f"Function {func_name} not found on plugin {self.name}")
        if not func.entry_point:
            raise ModuleNotFoundError(f"Function {func_name} entry point not found (plugin {self.name})")
        try:
            func_module = self.get_entry_module(func.entry_point)
        except FileNotFoundError:
            raise NotImplementedError(f"Function {func_name} module not found (plugin {self.name})")
        func_object: Callable[..., Any] | None = self.get_function_from_module(func_module, func.name)
        return func_object

    async def run_plugin_function(self, func_name: str, func_input: dict):
        func = self.get_func_by_name(func_name)
        if not func or not func.name:
            raise KeyError(f"Function {func_name} not found on plugin {self.name}")
        func_object: Callable[..., Any] | None = await self.get_function_object(func.name)
        if not func_object:
            raise ModuleNotFoundError(
                f"Function {func_name} not found on plugin module {func.entry_point} :: {self.name}"
            )

        if inspect.iscoroutinefunction(func_object):
            output_data = await func_object(**func_input)
        else:
            output_data = func_object(**func_input)
        return output_data

    def get_function_by_capability(self, capability: FunctionCapability) -> Optional[Func]:
        for func in self.funcs:
            if func.capability == capability:
                return func
        return None

    def get_webhook_function(self) -> Optional[Func]:
        func = self.get_function_by_capability(FunctionCapability.WEBHOOK)
        if not func:
            raise ValueError(f"Plugin {self.name} webhook function not found")
        return func

    def get_webhook_mapping_function(self) -> Optional[Func]:
        func = self.get_function_by_capability(FunctionCapability.WEBHOOK_KEYS_MAPPING)
        if not func:
            raise ValueError(f"Plugin {self.name} webhook mapping function not found")
        return func

    async def invoke_webhook(self, request_info: RequestInfo):
        try:
            mapping_func = self.get_webhook_mapping_function()
            if not mapping_func or not mapping_func.name:
                raise ValueError(f"Webhook error: Plugin {self.name} mapping function not found")
            func_input = request_info.request_parameters
            result: Plugin | PluginResponse | None = await self.run_plugin_function(mapping_func.name, func_input)
            if not result:
                raise ValueError(f"Webhook error: Plugin {self.name} plugin not found")
            if isinstance(result, PluginResponse):
                return result.value
            plugin = result

            webhook_func = self.get_webhook_function()
            if not webhook_func or not webhook_func.name:
                raise ValueError(f"Webhook error: Plugin {self.name} webhook function not found")
            func_object = await self.get_function_object(webhook_func.name)
            if not func_object:
                raise ValueError(f"Webhook error: Plugin {self.name} webhook function not found")
            func_input = await plugin.get_function_input(request_info, func_object)
            return await self.run_plugin_function(webhook_func.name, func_input)
        except Exception as e:
            logging.error(f"Webhook error: {e}")
            # TODO align return type
            return ApiFailResponse(message="Error invoking webhook")

    def __repr__(self):
        return self.name or self.get_type()


def get_manifest_json_path(name: str):
    manifest_folder = get_manifest_folder(name)
    if not manifest_folder:
        raise Exception("manifest not found")
    fpplugin_json_path = os.path.join(manifest_folder, "fpplugin.json")
    if not os.path.exists(fpplugin_json_path):
        raise Exception("manifest json not found")
    return fpplugin_json_path


class Plugin(Entity):
    def __init__(self, **kwargs):
        if "name" not in kwargs and "title" in kwargs:  # TODO, remove when we align all fpplugin.json
            kwargs["name"] = kwargs["title"]
        super().__init__(**kwargs)

    type: str = APIField(default=BuiltinEntityType.PLUGIN.value)
    name: str | None = APIField(description="The unique name of the plugin manifest", default=None)
    version: Optional[str] = APIField(default="0.0.0-error")
    install_target: Optional[TypeId] = APIField(description="The entity type the plugin installed on", default=None)
    _api_visible: ClassVar[bool] = True
    sync_services: List[SyncService] = Field(
        description="The sync services that the plugin provides", default_factory=list
    )
    manifest_: PluginManifest | None = NoDbBField(None)
    webhook_keys: Optional[List[str]] = None

    async def add_webhook_key(self, webhook_key: str):
        if not self.webhook_keys:
            self.webhook_keys = []
        self.webhook_keys.append(webhook_key)
        await self.save()

    async def remove_webhook_key(self, webhook_key: str):
        if not self.webhook_keys:
            return
        self.webhook_keys.remove(webhook_key)
        await self.save()

    async def get_manifest(self) -> Optional[PluginManifest]:
        if not self.manifest_:
            if not self.name:
                raise ValueError("Plugin name not found")
            self.manifest_ = await PluginManifest.get_by_name(self.name)
        DEVELOPMENT = os.getenv("DEVELOPMENT", False)
        if not self.manifest_ and DEVELOPMENT:  # allow non installed manifests on development
            if not self.name:
                raise ValueError("Plugin name not found")
            fpplugin_json_path = get_manifest_json_path(self.name)
            self.manifest_ = await PluginManifest.from_fpplugin(fpplugin_json_path)
        return self.manifest_

    async def get_function_input(self, request_info: RequestInfo, func_object: Callable[..., Any]) -> Dict[str, Any]:
        inputs = {}
        signature = inspect.signature(func_object)
        type_hints = get_type_hints(func_object)
        request_params = {}

        # Handle request parameters based on HTTP method
        if request_info.request:
            if request_info.request.method == "POST":
                # noinspection PyBroadException
                request_params = request_info.request_parameters
                logging.info(f"  Body: {request_params}\n")
            else:
                # For GET requests, use request parameters
                request_params = request_info.request_parameters

        for name, param in signature.parameters.items():
            param_type: type | None = type_hints.get(name, None)
            default_value = param.default if param.default is not inspect.Parameter.empty else "No default value"
            param_kind = param.kind
            logging.info(f"Parameter: {name}")
            logging.info(f"  Type: {param_type}")
            logging.info(f"  Default: {default_value}")
            logging.info(f"  Kind: {param_kind}\n")
            if name == "request" and param_type is Request:
                inputs[name] = request_info.request
            if name == "request_params" and param_type is dict:
                inputs[name] = request_info.request_parameters
            if name == "user_credentials":
                credentials = await self.get_user_credentials()
                if not credentials or not param_type:
                    logging.error(f"User credentials not found for {self.name}")
                    continue
                if issubclass(param_type, BaseModel):
                    inputs[name] = param_type.model_validate(credentials.value)
                else:
                    inputs[name] = credentials.value
            elif name == "app_credentials":
                credentials = await self.get_entity_credentials()
                if not credentials or not param_type:
                    logging.error(f"App credentials not found for {self.name}")
                    continue
                if issubclass(param_type, BaseModel):
                    inputs[name] = param_type.model_validate(credentials.value)
                else:
                    inputs[name] = credentials.value
            elif name in request_params:
                inputs[name] = request_params[name]
            inputs["plugin"] = self
        return inputs

    @action.all()
    async def call(self) -> ApiResponse | None:
        try:
            request_info = get_current_request_info()
            if not request_info:
                return ApiFailResponse(message="Request info not found")
            func_name = request_info.sub_path
            if not func_name:
                return ApiFailResponse(message="Function name not found")
            manifest = await self.get_manifest()
            if not manifest:
                return ApiFailResponse(message=f"Plugin manifest not found {self.name}")
            func_object = await manifest.get_function_object(func_name)
            if not func_object:
                return ApiFailResponse(message=f"Function {func_name} not found in plugin {self.name}")
            func_input = await self.get_function_input(request_info, func_object)
            output_data = await manifest.run_plugin_function(func_name, func_input)
            return ApiSuccessResponse(data=output_data)
        except KeyError as e:
            logging.error(f"Plugin call key error: {e}")
            return ApiFailResponse(message=str(e))
        except ModuleNotFoundError as e:
            logging.error(f"Plugin call nodule error: {e}")
            return ApiFailResponse(message=str(e))
        except Exception as e:
            logging.error(f"Plugin call error: {e}")
            return ApiFailResponse(message="Error calling plugin function")

    # Instance Configuration
    # base_url: Optional[str] = Field(description="Base URL for the service if applicable", default=None)
    # auth_type: Optional[str] = Field(description="Authentication method if applicable", default=None)
    # credentials: Dict[str, SecretStr] = Field(description="Authentication credentials", default_factory=dict)
    # Instance State
    # status: PluginStatus = Field(default=PluginStatus.INACTIVE)
    # is_default: bool = Field(description="Whether this is the default instance for the user", default=False)
    # last_used: Optional[str] = Field(default=None)
    # Custom Configuration
    # settings: Dict[str, Any] = Field(description="Instance-specific settings", default_factory=dict)

    def __str__(self):
        return self.name or self.get_type()

    def __repr__(self):
        return self.name or self.get_type()

    @property
    def _sod_key(self):
        return f"plugin_{self.name}_{self.id}"

    async def get_user_credentials(self, foreign_key: str | None = None) -> Optional[PluginCredentials]:
        sod_store: SodDriver = get_current_sod_store()
        value = await sod_store.read_user_sod(self._sod_key, foreign_key)
        return PluginCredentials(value=value)

    async def set_user_credentials(self, value: JSONType, foreign_key: str | None = None):
        sod_store: SodDriver = get_current_sod_store()
        return await sod_store.write_user_sod(self._sod_key, value, foreign_key)

    async def get_entity_credentials(self) -> Optional[PluginCredentials]:
        sod_store: SodDriver = get_current_sod_store()
        value = await sod_store.read_sod(self._sod_key)
        return PluginCredentials(value=value)

    async def set_entity_credentials(self, value) -> Optional[PluginCredentials]:
        sod_store: SodDriver = get_current_sod_store()
        return await sod_store.write_sod(self._sod_key, value)

    async def uninstall(self):
        """Uninstall the plugin by deleting it and cleaning up its credentials."""
        # Clean up credentials based on plugin type
        sod_store: SodDriver = get_current_sod_store()
        if self.install_target and self.install_target.type == BuiltinEntityType.USER.value:
            await sod_store.delete_user_sod(self._sod_key)
        elif self.install_target and self.install_target.type == BuiltinEntityType.WORKSPACE.value:
            await sod_store.delete_sod(self._sod_key)

        # Delete the plugin entity
        await self.delete()

    @staticmethod
    async def get_external_plugins_urls() -> Dict[str, str]:
        return await fetch_json(os.path.join("plugins", "external-plugins.json"))

    @classmethod
    async def get_by_title(cls, title: str) -> Optional["Plugin"]:
        return await cls.get_one({"title": title})

    @classmethod
    async def get_by_name(cls, name: str) -> Optional["Plugin"]:
        return await cls.get_one({"name": name})

    @classmethod
    async def get_by_hook_id(cls, hook_id: str) -> Optional["Plugin"]:
        return await cls.get_one({"hook_id": hook_id})
