import asyncio
import os
from typing import Any, Callable, Literal, Sequence, TypeVar, overload

import anyio

recommended_concurrency_limit = min(32, (os.cpu_count() or 1) + 4)


class AsyncEventEmitter:
    def __init__(self):
        self._listeners: dict[str, list[Callable[..., Any]]] = {}

    def on(self, event_name: str, callback: Callable[..., Any]) -> None:
        """Registers an async listener for a specific event."""
        if event_name not in self._listeners:
            self._listeners[event_name] = []
        self._listeners[event_name].append(callback)

    def off(self, event_name: str, callback: Callable[..., Any]) -> None:
        """Removes a specific listener for a specific event."""
        if event_name in self._listeners:
            try:
                self._listeners[event_name].remove(callback)
                # Clean up if no listeners remain for the event
                if not self._listeners[event_name]:
                    del self._listeners[event_name]
            except ValueError:
                pass  # Ignore if the callback was not found

    async def emit(self, event_name: str, *args: Any, **kwargs: Any) -> None:
        """Emits an event and calls all registered async listeners."""
        for callback in self._listeners.get(event_name, []):
            if asyncio.iscoroutinefunction(callback):
                await callback(*args, **kwargs)
            else:
                callback(*args, **kwargs)


T = TypeVar("T")


def filter_none_from_list(lst: Sequence[T | None]) -> list[T]:
    return [item for item in lst if item is not None]


@overload
async def read_files_in_parallel(
    files: list[str],
    mode: Literal["rb"],
    encoding: str | None = None,
    return_errors: bool = True,
    offsets: list[int] | None = None,
    lengths: list[int] | None = None,
) -> list[bytes]: ...


@overload
async def read_files_in_parallel(
    files: list[str],
    mode: Literal["r"] = "r",
    encoding: str | None = None,
    return_errors: bool = True,
    offsets: list[int] | None = None,
    lengths: list[int] | None = None,
) -> list[str]: ...


async def read_files_in_parallel(
    files: list[str],
    mode: Literal["r", "rb"] = "r",
    encoding: str | None = None,
    return_errors: bool = True,
    offsets: list[int] | None = None,
    lengths: list[int] | None = None,
) -> list[str] | list[bytes]:
    """
    Read the content of multiple files concurrently.
    Returns a list of file contents, and an error message if unable to read a file.
    """
    if offsets is None:
        offsets = [0] * len(files)
    if lengths is None:
        lengths = [-1] * len(files)

    async def read_file_content(path, offset, length, semaphore, mode, encoding):
        async with semaphore:
            try:
                async with await anyio.open_file(path, mode=mode, encoding=encoding) as file:
                    await file.seek(offset)
                    return await file.read(length)
            except Exception as e:
                if return_errors:
                    return str(e)  # Return error message as content if unable to read
                else:
                    raise e

    file_read_semaphore = asyncio.Semaphore(recommended_concurrency_limit)
    return await asyncio.gather(
        *(
            read_file_content(path, offset, length, file_read_semaphore, mode, encoding)
            for path, offset, length in zip(files, offsets, lengths)
        )
    )
