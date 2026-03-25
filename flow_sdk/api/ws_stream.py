import asyncio
import time
from enum import Enum
from typing import Any, Callable, Optional

import msgpack
from pydantic import BaseModel, field_serializer, field_validator
from starlette.websockets import WebSocket

# Import your in-memory cache (assumed to be defined elsewhere)
from cache.in_memory_cache import InMemoryCache, InMemoryCacheConfig


class StreamProvider(Enum):
    GCP = "Google"
    RECALL = "Recall"
    GLADIA = "Gladia"


class StreamDataType(Enum):
    TEST_SLOW = "TEST_SLOW"
    TEST_FAST = "TEST_FAST"
    AUDIO = "AUDIO"
    VIDEO = "VIDEO"


StreamHandler = Callable[["WSBinaryStream"], Any]


class Streamer:
    def __init__(self, stream: "WSBinaryStream"):
        self.stream = stream

    async def on_init(self) -> bool:
        return True

    async def on_upstream(self, chunk: Any) -> Optional[str]:
        pass

    async def on_downstream(self, chunk: Any) -> Optional[str]:
        pass

    @property
    def websocket(self) -> WebSocket:
        if not self.stream.websocket:
            raise ValueError("WebSocket not initialized")
        return self.stream.websocket

    @property
    def config(self):
        return self.stream.config


class WSBinaryStreamApi(BaseModel):
    id: Optional[int] = -1
    data_type: Optional[StreamDataType] = None
    config: Optional[Any] = None

    @field_serializer("data_type")
    def serialize_data_type(self, value: StreamDataType) -> str:
        return value.value

    # noinspection PyNestedDecorators
    @field_validator("data_type", mode="before")
    @classmethod
    def parse_data_type(cls, value):
        if isinstance(value, StreamDataType):
            return value
        if isinstance(value, str):
            if value in (e.value for e in StreamDataType):
                return StreamDataType(value)
            raise ValueError(f"Invalid enum stream type: {value}")
        raise ValueError(f"Invalid stream type: {value}")


class WSBinaryStream:
    def __init__(self, stream_info: WSBinaryStreamApi):
        self.stream_info = stream_info
        self._upstream_queue = asyncio.Queue()
        self._downstream_queue = asyncio.Queue()
        self._last_activity = time.time()
        self._websocket: Optional[WebSocket] = None
        self._streamer_started: bool = False  # flag to ensure we only start processing once
        # Timeout in seconds for inactivity (adjust as needed)
        self.inactivity_timeout: float = 30.0
        self.streamer: Optional[Streamer] = None
        self.initialized = False

    async def init(self, websocket: WebSocket):
        self._websocket = websocket
        self.initialized = True

    async def add_to_upstream_queue(self, data: bytes):
        """Adds a data chunk to the stream’s queue and updates last activity.
        Also ensures the processing handler is running."""
        self._last_activity = time.time()
        self._upstream_queue.put_nowait(data)
        if not self._streamer_started:
            self._streamer_started = True
            # Start processing in the background.
            await self.streamer.on_init()
        # asyncio.create_task(self._process_upstream_queue()) # this will make stream processing unordered
        await self._process_upstream_queue()

    async def send_downstream(self, data: bytes):
        """Adds a data chunk to the stream’s queue and updates last activity.
        Also ensures the processing handler is running."""
        self._last_activity = time.time()
        self._downstream_queue.put_nowait(data)
        return await self._process_downstream_queue()

    async def _process_upstream_queue(self):
        """
        Processes the stream by launching the Google Speech streaming handler
        in a background thread.
        """
        await self.streamer.on_upstream(self._upstream_queue.get_nowait())

    async def _process_downstream_queue(self):
        """
        Processes the stream by launching the Google Speech streaming handler
        in a background thread.
        """
        data = self._downstream_queue.get_nowait()
        msg = msgpack.packb([self.id, data])
        await self.websocket.send_bytes(msg)

    async def cleanup(self):
        _streams.remove(self.id)

    @property
    def id(self):
        return self.stream_info.id

    @id.setter
    def id(self, value):
        self.stream_info.id = value

    @property
    def config(self):
        return self.stream_info.config

    @property
    def websocket(self):
        return self._websocket

    @property
    def upstream_queue(self):
        return self._upstream_queue

    @property
    def downstream_queue(self):
        return self._downstream_queue


# A specialized config model for audio streams.
class WSAudioStreamConfig(BaseModel):
    sample_rate: int
    codec: str


# Inherit from WSBinaryStream for audio streams.
class WSAudioStream(WSBinaryStream):
    config: WSAudioStreamConfig


# Global in-memory cache configuration and registry for active streams.
_cache_config = InMemoryCacheConfig(default_ttl=3600, reset_ttl_on_get=True)
_streams: InMemoryCache[WSBinaryStream] = InMemoryCache[WSBinaryStream](_cache_config)
_next_id = 1


def get_ws_stream(stream_id: int) -> Optional[WSBinaryStream]:
    return _streams.get(stream_id)


def init_ws_stream(stream: WSBinaryStream):
    """
    Initializes a new stream: assigns a unique ID, registers it in the global cache,
    and returns the stream ID.
    """
    global _next_id
    stream.id = _next_id
    _next_id += 1
    _streams.set(stream.id, stream)
    return stream.id
