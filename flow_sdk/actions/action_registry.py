import inspect
import logging
from typing import Any, Callable, Dict, List, Optional

from fastapi import HTTPException
from pydantic.fields import FieldInfo

ActionHandler = Callable[..., Any]


class Action:
    def __init__(
        self,
        action_name: str,
        function_name: str,
        handler: ActionHandler,
        methods: str | List[str] | None = None,
        types: str | List[str] | None = None,
        allow_missing_target: bool = False,
    ):
        self.action_name: str = action_name
        self.function_name: str = function_name
        self.methods: List[str] = []
        self.types: List[str] = []
        self.handler: ActionHandler = handler
        self.allow_missing_target = allow_missing_target
        if types:
            if isinstance(types, str):
                self.types.append(types)
            if isinstance(types, list):
                self.types.extend(types)
        if methods:
            if isinstance(methods, str):
                self.methods.append(methods.lower())
            if isinstance(methods, list):
                self.methods.extend(method.lower() for method in methods)

    def is_allowed_method(self, method: str) -> bool:
        if len(self.methods) == 1 and "all" in self.methods:
            return True
        return method.lower() in [m.lower() for m in self.methods]

    def __call__(self, func):
        def wrapper(*args, **kwargs):
            return func(*args, **kwargs)

        return wrapper


class ActionManager:
    def __init__(self):
        self.function_registry: Dict[str, Action] = {}
        self.scanned = False

    def load_test_action(self):
        self.register(
            action_name="resetAvailableOnlyForLocalUserOnTesting",
            function_name="resetAvailableOnlyForLocalUserOnTesting",
            methods="post",
            handler=lambda _: {"status": "SUCCESS", "data": True},
        )

    def reset(self):
        self.function_registry = {}

    def get_by_name(self, name: str, entity_type: Optional[str] = None) -> Action | None:
        name = name.lower()
        if entity_type:
            entity_action_key = f"{entity_type}.{name}"
            if entity_action_key in self.function_registry:
                return self.function_registry[entity_action_key]
        if name in self.function_registry:
            return self.function_registry[name]
        return None

    def register(
        self,
        action_name: str,
        function_name: str,
        handler: ActionHandler,
        methods: List[str] | str = "all",
        types: List[str] | str = "all",
        allow_missing_target: bool = False,
    ):
        action_name = action_name.lower()
        a = Action(
            action_name,
            function_name,
            handler,
            methods,
            types,
            allow_missing_target=allow_missing_target,
        )
        self.function_registry[action_name] = a
        return a

    def get_all_actions(self) -> List[Action]:
        return list(self.function_registry.values())

    def get_all_actions_names(self) -> List[str]:
        return [a.action_name for a in self.get_all_actions()]

    def all(
        self,
        action_name=None,
        methods: List[str] | str = "all",
        types: List[str] | str = "all",
        allow_missing_target: bool = False,
    ):
        def decorator(func):
            qualname = getattr(func, "__qualname__", action_name or func.__name__)
            current_frame = inspect.currentframe()
            if not current_frame:
                raise ValueError("No current frame found")
            frame = current_frame.f_back
            if not frame:
                raise ValueError("No frame found")
            type_field = (
                frame.f_locals["type"]
                if "type" in frame.f_locals and isinstance(frame.f_locals["type"], FieldInfo)
                else None
            )
            if type_field:
                # Use class type variable instead of the first part of the qualname (i.e. the class name)
                qualname = ".".join([type_field.default] + qualname.split(".")[1:])
            elif isinstance(types, list) and len(types) == 1:
                # Top-level decorator scoped to a single entity type — prefix
                # the storage key with that type so two actions sharing a name
                # on different entity types don't overwrite each other.
                # ``get_by_name`` already tries ``<entity_type>.<name>`` before
                # falling back to bare ``name``.
                qualname = f"{types[0]}.{qualname}"
            if action_name:
                # Use action_name at the end of the qualname
                qualname = ".".join(qualname.split(".")[:-1] + [action_name])
            self.register(
                qualname,
                func.__name__,
                func,
                methods,
                types,
                allow_missing_target=allow_missing_target,
            )
            return func

        return decorator

    def get(self, *args, **kwargs):
        """
        Decorator for registering a GET action.
        Accepts any positional and keyword arguments, and forwards them to the `all` decorator,
        while always setting the HTTP method to 'get'.
        """
        # If a positional argument for the 'methods' parameter is present (i.e. the second positional argument),
        # remove it so that it doesn't conflict with our forced "get" value.
        if len(args) >= 2:
            # Retain the first argument (action_name) and skip the second argument (which would be methods).
            args = (args[0],) + args[2:]
        kwargs["methods"] = "get"
        return self.all(*args, **kwargs)

    def post(self, *args, **kwargs):
        """
        Decorator for registering a POST action.
        Accepts any positional and keyword arguments, and forwards them to the `all` decorator,
        while always setting the HTTP method to 'post'.
        """
        # If a positional argument for the 'methods' parameter is present (i.e. the second positional argument),
        # remove it so that it doesn't conflict with our forced "post" value.
        if len(args) >= 2:
            # Retain the first argument (action_name) and skip the second argument (which would be methods).
            args = (args[0],) + args[2:]
        kwargs["methods"] = "post"
        return self.all(*args, **kwargs)

    def delete(self, *args, **kwargs):
        """
        Decorator for registering a DELETE action.
        Accepts any positional and keyword arguments, and forwards them to the `all` decorator,
        while always setting the HTTP method to 'delete'.
        """
        # If a positional argument for the 'methods' parameter is present (i.e. the second positional argument),
        # remove it so that it doesn't conflict with our forced "delete" value.
        if len(args) >= 2:
            # Retain the first argument (action_name) and skip the second argument (which would be methods).
            args = (args[0],) + args[2:]
        kwargs["methods"] = "delete"
        return self.all(*args, **kwargs)


action = ActionManager()


def is_action(key: str, entity_type: Optional[str] = None) -> bool:
    return action.get_by_name(key, entity_type) is not None


def get_action_from_method(method: str):
    if not method:
        logging.error(f"Missing method: {method}")
        raise HTTPException(500, "get action : Missing method")
    method = method.upper()
    if method == "POST":
        return "create"
    elif method == "GET":
        return "read"
    elif method == "PUT":
        return "update"
    elif method == "PATCH":
        return "update"
    elif method == "DELETE":
        return "delete"
    elif method == "OPTIONS":
        return None
    else:
        logging.error(f"Unknown method: {method}")
        raise HTTPException(500, f"Unknown method: {method}")
