#!/usr/bin/env python3
"""Fail if a Windows executable needs a DLL that a clean Windows install does not ship.

Rust's MSVC target links the Visual C++ runtime dynamically unless told otherwise, so a
binary built without ``+crt-static`` (``flow_sdk/rust/.cargo/config.toml``) imports
``VCRUNTIME140.dll`` and dies on a fresh machine with 0xC0000135 before ``main`` runs. For
``flow-rs.exe`` that silently broke the desktop app's keychain, and with it FlowPad sign-in.
CI runners have the runtime installed, so nothing else would ever catch it.

Reads the PE import table with the standard library only, so it runs on any CI image.

    python scripts/check_windows_exe_deps.py path/to/flow-rs.exe [more.exe ...]
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

#: The Visual C++ Redistributable's DLLs. The UCRT (api-ms-win-crt-*, ucrtbase.dll) is part of
#: Windows 10+ and is fine to import.
REDIST_DLLS = ("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll", "vcomp140.dll")


def imported_dlls(path: Path) -> list[str]:
    data = path.read_bytes()
    if data[:2] != b"MZ":
        raise ValueError(f"{path}: not a PE file")
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe : pe + 4] != b"PE\0\0":
        raise ValueError(f"{path}: no PE signature")
    n_sections = struct.unpack_from("<H", data, pe + 6)[0]
    opt_size = struct.unpack_from("<H", data, pe + 20)[0]
    opt = pe + 24
    magic = struct.unpack_from("<H", data, opt)[0]
    data_dirs = opt + (112 if magic == 0x20B else 96)  # PE32+ vs PE32
    import_rva = struct.unpack_from("<I", data, data_dirs + 8)[0]  # directory entry 1
    sections = [struct.unpack_from("<IIII", data, opt + opt_size + 40 * i + 8) for i in range(n_sections)]

    def offset(rva: int) -> int:
        for vsize, vaddr, raw_size, raw_ptr in sections:
            if vaddr <= rva < vaddr + max(vsize, raw_size):
                return rva - vaddr + raw_ptr
        raise ValueError(f"{path}: RVA {rva:#x} is in no section")

    names: list[str] = []
    entry = offset(import_rva) if import_rva else None
    while entry is not None:
        name_rva = struct.unpack_from("<I", data, entry + 12)[0]
        if name_rva == 0:
            break
        start = offset(name_rva)
        names.append(data[start : data.index(b"\0", start)].decode("ascii"))
        entry += 20
    return names


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)  # noqa: T201 — a CLI: stdout is its interface
        return 2
    bad = 0
    for arg in argv:
        path = Path(arg)
        needs = [dll for dll in imported_dlls(path) if dll.lower() in REDIST_DLLS]
        if needs:
            bad += 1
            print(f"FAIL {path}: needs {', '.join(needs)} (Visual C++ Redistributable - absent on a clean Windows)")  # noqa: T201
        else:
            print(f"ok   {path}: no Visual C++ Redistributable DLLs")  # noqa: T201
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
