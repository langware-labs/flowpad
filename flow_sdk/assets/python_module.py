"""Import an asset's Python module within its own relative-import package."""

import importlib
import importlib.abc
import importlib.machinery
import importlib.util
import sys
from pathlib import Path
from types import ModuleType


class _SourceLoader(importlib.machinery.SourceFileLoader):
    def get_code(self, fullname):
        # Content-addressed reload must not read mtime/size-addressed pyc bytes.
        return self.source_to_code(self.get_data(self.path), self.path)


class _AssetFinder(importlib.abc.MetaPathFinder):
    packages: set[str] = set()

    def find_spec(self, fullname, path=None, target=None):
        if fullname.partition(".")[0] not in self.packages:
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path, target)
        if spec is not None and isinstance(spec.loader, importlib.machinery.SourceFileLoader):
            spec.loader = _SourceLoader(fullname, spec.origin)
        return spec


_SOURCE_FINDER = _AssetFinder()


def load_package_module(folder: Path, module: str, package: str, *, fresh_source: bool = False) -> ModuleType:
    """The caller owns identity, revision and authority; this owns Python imports."""
    if fresh_source:
        _SOURCE_FINDER.packages.add(package)
        if _SOURCE_FINDER not in sys.meta_path:
            sys.meta_path.insert(0, _SOURCE_FINDER)
    if package not in sys.modules:
        spec = importlib.machinery.ModuleSpec(package, None, is_package=True)
        spec.submodule_search_locations = [str(folder)]
        sys.modules[package] = importlib.util.module_from_spec(spec)
    return importlib.import_module(f"{package}.{module}")
