# The Visual C++ runtime DLL search needs

`usearch` (the vector index behind search) is C++: its compiled module imports `MSVCP140.dll`, which Python does
not bundle and a clean Windows does not ship. Installing the Microsoft redistributable is machine-wide, so it always
opens a Windows permission prompt (UAC). These two files let search work **without installing anything**.

`flow_sdk.rag.runtime.use_app_local_runtime()` registers the folder for this interpreter's architecture with
`os.add_dll_directory` — but only as a fallback, after a normal `import usearch` already failed. A machine that has
the redistributable keeps using its own copy, which Windows Update patches; ours is never loaded there.

| folder | for a Python that is | version | SHA-256 |
|---|---|---|---|
| `win-amd64/msvcp140.dll` | x64 (also x64 under emulation on ARM64) | 14.44.35211.0 | `0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9` |
| `win-arm64/msvcp140.dll` | ARM64 | 14.44.35211.0 | `045faeab0b5710816ae160ea20dae8495ffc11bb51feca15d22aaf7ff3752cb3` |

The hashes are pinned in `flow_sdk/rag/runtime.py`; a file that does not match is never put on the search path.

## Provenance

The bytes are Microsoft's, unmodified. They were taken from the `msvcp140.dll` inside the PyPI wheels of
[`msvc-runtime`](https://pypi.org/project/msvc-runtime/) 14.44.35112 (`win_amd64`, `win_arm64`), and each was
checked on Windows with `Get-AuthenticodeSignature` — `Status: Valid`, signed by Microsoft. Where the bytes came from
is therefore not what is trusted; the signature is. Microsoft lists the Visual C++ runtime DLLs as redistributable
("app-local") files.

To update: download both wheels, extract `msvcp140.dll`, check the signature on Windows, replace the files, and
update the hashes here and in `runtime.py` (`tests/unit/test_rag_vcruntime.py` fails until they agree).

## What this does NOT do

Windows Update does not patch these copies, so they should be refreshed with the runtime that Flowpad builds against.
`vcruntime140.dll` and `vcruntime140_1.dll`, the other two DLLs `usearch` links, are not shipped here: the Python that
Flowpad installs (uv's python-build-standalone) carries both next to the interpreter.
