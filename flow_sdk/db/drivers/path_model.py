from typing import Generic, List, TypeVar
from flow_sdk._compat import Unpack

from pydantic import BaseModel, ConfigDict

NodeType = TypeVar("NodeType")
RelType = TypeVar("RelType")


class NodeConnection(BaseModel, Generic[NodeType, RelType]):
    source: NodeType
    rel: RelType
    target: NodeType

    def __repr__(self):
        sid = getattr(self.source, "id", None)
        sid = getattr(self.source, "email", sid)
        sid = getattr(self.source, "function_name", sid)
        stype = getattr(self.source, "type", None)
        tid = getattr(self.target, "id", None)
        tid = getattr(self.target, "email", tid)
        tid = getattr(self.target, "function_name", tid)
        ttype = getattr(self.target, "type", None)
        rtype = getattr(self.rel, "type", None)
        return f"{stype} ({sid}) -> {rtype} -> {ttype} ({tid})"

    def __str__(self):
        return self.__repr__()


class NodesPath(BaseModel, Generic[NodeType, RelType]):
    model_config = ConfigDict(from_attributes=True, arbitrary_types_allowed=True)

    connections: List[NodeConnection[NodeType, RelType]] = []

    def __init_subclass__(cls, **kwargs: Unpack[ConfigDict]):
        super().__init_subclass__(**kwargs)

    def __repr__(self):
        s = ""
        for c in self.connections:
            s += str(c)
            if c != self.connections[-1]:
                s += " ==> "
        return s

    @property
    def start(self):
        return self.connections[0].source

    @property
    def end(self):
        return self.connections[-1].target

    @property
    def nodes(self):
        return [c.source for c in self.connections] + [self.end]

    @property
    def distinct_nodes(self):
        return list(set(self.nodes))
