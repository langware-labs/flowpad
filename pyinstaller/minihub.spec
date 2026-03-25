# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for minihub backend server.
Packages the minihub FastAPI server and flow-sdk into a standalone executable.
"""

import os
import sys
from pathlib import Path
from PyInstaller.utils.hooks import copy_metadata, collect_data_files

# Get the root directory (parent of pyinstaller folder)
ROOT_DIR = Path(SPECPATH).parent.resolve()
MINIHUB_DIR = ROOT_DIR / 'minihub'
SDK_DIR = ROOT_DIR / 'flow-sdk' / 'python'

# Hidden imports that PyInstaller might miss
hidden_imports = [
    # FastAPI/Starlette
    'uvicorn',
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'starlette',
    'starlette.routing',
    'starlette.middleware',
    'starlette.middleware.cors',
    'fastapi',
    'fastapi.middleware',
    'fastapi.middleware.cors',

    # Async
    'anyio',
    'anyio._backends',
    'anyio._backends._asyncio',

    # Database
    'sqlalchemy',
    'sqlalchemy.ext.asyncio',
    'aiosqlite',

    # HTTP clients
    'httpx',
    'httpcore',

    # Pydantic
    'pydantic',
    'pydantic_settings',

    # Utils
    'dotenv',
    'python-dotenv',
    'watchfiles',

    # PTY support (terminal)
    'ptyprocess',
    'winpty',
    'pywinpty',
    'pywinpty.winpty',

    # Minihub modules
    'minihub',
    'minihub.server',
    'minihub.state',
    'minihub.routes',
    'minihub.middleware',
    'minihub.reporters',

    # Flow SDK modules
    'flow_sdk',
    'flow_sdk.core',
    'flow_sdk.db',
    'flow_sdk.api',
    'flow_sdk.models',
    'flow_sdk.utils',
    'flow_sdk.storage',
    'flow_sdk.config',
]

# Collect data files (only include directories that exist)
datas = []
_static_dir = MINIHUB_DIR / 'static'
if _static_dir.exists():
    datas.append((str(_static_dir), 'minihub/static'))
_ui_dist_dir = MINIHUB_DIR / 'ui' / 'dist'
if _ui_dist_dir.exists():
    datas.append((str(_ui_dist_dir), 'minihub/ui/dist'))

# Add package metadata that PyInstaller doesn't collect automatically
# Use helper to skip missing packages gracefully
def safe_copy_metadata(package_name):
    """Copy metadata if package exists, otherwise return empty list."""
    try:
        return copy_metadata(package_name)
    except Exception:
        print(f"Warning: Could not copy metadata for {package_name}, skipping...")
        return []

metadata_packages = [
    'genai_prices',
    'pydantic_ai',
    'pydantic_ai_slim',
    'httpx',
    'openai',
    'anthropic',
    'cohere',
    'groq',
]

for pkg in metadata_packages:
    datas += safe_copy_metadata(pkg)

# Add flow-sdk as a source path
pathex = [
    str(ROOT_DIR),
    str(SDK_DIR),
]

a = Analysis(
    [str(MINIHUB_DIR / 'run.py')],
    pathex=pathex,
    binaries=[],
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'PIL',
        'pandas',
        'scipy',
        'pytest',
        'IPython',
        'notebook',
        'jupyter',
        # Exclude logfire - causes issues with PyInstaller (getsource fails)
        'logfire',
        'logfire.integrations',
        'logfire.integrations.pydantic',
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='minihub',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='minihub',
)
