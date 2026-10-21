"""``gdrive_mount`` -- a folder of Google Drive, used through Google Drive for desktop.

The same folders as the ``gdrive`` (API) driver -- ``<path>/<dataset>/rows/<key>/row.json`` -- but reached
through the Drive folder Drive for desktop keeps on this computer (macOS: ``~/Library/CloudStorage/
GoogleDrive-<account>/My Drive``; Windows: ``<letter>:\\My Drive``). A dataset in a source of this driver
is a LOCAL folder (``rows_folder``): its rows are read and written there in place, and Drive for desktop
uploads and downloads them, with its own retries and offline edits. No API calls, no token, no working
copy.

What differs from the API driver is only setup -- install the app, sign in, make the folder -- declared as
setup steps the ``gdrive-mount-setup`` wizard runs, and the sync mode. Until setup holds, the source owes
it and its datasets keep their rows locally.

Where My Drive is depends on the machine, so it is FOUND each time (``mount_root`` overrides it), never
stored in the source's file: ``path`` is the one thing every machine shares.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any, Mapping, Optional

from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.folder import FolderSource
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.setup_steps import setup_step

#: Google's own download of Drive for desktop for macOS (a disk image holding the installer package).
MAC_INSTALLER_URL = "https://dl.google.com/drive-file-stream/GoogleDrive.dmg"
MAC_APP = Path("/Applications/Google Drive.app")
WINDOWS_APP = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Google" / "Drive File Stream"
#: Drive for desktop's settings domain (macOS ``defaults``).
SETTINGS_DOMAIN = "com.google.drivefs.settings"
NOT_MOUNTED = "~/Google Drive (not mounted)"


class MountConfig(SourceConfig):
    """What a mounted-Drive source is configured with."""

    path: str = ""
    account: str = ""
    mount_root: str = ""


def _segments(path: str) -> list[str]:
    return [part for part in str(path or "").replace("\\", "/").split("/") if part.strip()]


def installed() -> bool:
    if sys.platform == "darwin":
        return MAC_APP.is_dir()
    if sys.platform == "win32":
        return WINDOWS_APP.is_dir()
    return False


def _settings_mount_point() -> Optional[str]:
    """``DefaultMountPoint`` as Drive for desktop's settings say (macOS), or None."""
    try:
        said = subprocess.run(["defaults", "read", SETTINGS_DOMAIN, "DefaultMountPoint"],
                              capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    value = said.stdout.strip()
    return value if said.returncode == 0 and value else None


def _candidates(account: str) -> list[Path]:
    """Where My Drive may be on this computer, most likely first."""
    out: list[Path] = []
    if sys.platform == "darwin":
        roots = sorted((Path.home() / "Library" / "CloudStorage").glob("GoogleDrive-*"))
        if account:
            roots = [r for r in roots if r.name.lower() == f"googledrive-{account.strip().lower()}"]
        out += [r / "My Drive" for r in roots]
        if not account:
            if mount_point := _settings_mount_point():
                out.append(Path(mount_point) / "My Drive")
            out += [Path("/Volumes/GoogleDrive/My Drive"), Path("/Volumes/Google Drive/My Drive")]
    elif sys.platform == "win32":
        out += [Path(f"{letter}:/My Drive") for letter in "GHIJKLMNOPQRSTUVWXYZ"]
    return out


def my_drive(config: Mapping[str, Any]) -> Optional[Path]:
    """My Drive on this computer, or None while Drive for desktop is not signed in and mounted."""
    if config.get("mount_root"):
        root = Path(str(config["mount_root"])).expanduser()
        return root if root.is_dir() else None
    return next((p for p in _candidates(str(config.get("account") or "")) if p.is_dir()), None)


class MountedDriveSource(FolderSource):
    """The folder ``path`` of My Drive, as the files Drive for desktop keeps on this computer."""

    Config = MountConfig
    provider = "gdrive_mount"

    # ── where the rows are: a local folder, read and written in place ─────────
    @classmethod
    def rows_within(cls, config: dict, path: str) -> dict:
        """A dataset's rows in the folder ``path`` inside this source's folder (as the API driver)."""
        return {**config, "path": "/".join(_segments(f"{config.get('path') or ''}/{path}"))}

    @classmethod
    def rows_folder(cls, config: Mapping[str, Any], path: str) -> Path:
        """The folder on this computer that holds a dataset's ``rows/``."""
        root = my_drive(config)
        if root is None:
            raise ValueError("Google Drive for desktop is not set up on this computer")
        return root.joinpath(*_segments(config.get("path") or ""), *_segments(path))

    @classmethod
    def configure(cls, row: Any) -> Mapping[str, Any]:
        """The folder this source watches: My Drive's ``path`` here (a placeholder until it is mounted, so
        the source still builds and its setup can say what is missing)."""
        config = dict(getattr(row, "config", None) or {})
        root = my_drive(config)
        target = root.joinpath(*_segments(config.get("path") or "")) if root else Path(NOT_MOUNTED).expanduser()
        return {"root": str(target)}

    # ── setup: install, sign in, the folder, and the check ────────────────────
    async def verify(self) -> Verdict:
        return await asyncio.to_thread(self._verdict)

    def _verdict(self) -> Verdict:
        config = self.binding.config
        if not installed():
            return Verdict(ready=False, detail="Google Drive for desktop is not installed on this computer.")
        root = my_drive(config)
        if root is None:
            who = f" as {config.get('account')}" if config.get("account") else ""
            return Verdict(ready=False, detail=f"Sign in to Google Drive for desktop{who}: My Drive is not on this computer yet.")
        folder = root.joinpath(*_segments(config.get("path") or ""))
        if not folder.is_dir():
            if not self.binding.holds_rows or self.binding.read_only:
                return Verdict(ready=False, detail=f"My Drive has no folder {config.get('path')!r}.")
            folder.mkdir(parents=True, exist_ok=True)   # a source holding rows makes its folder
        probe = folder / f".flowpad-check-{uuid.uuid4().hex[:8]}"
        try:
            probe.write_bytes(b"ok")
            probe.unlink()
        except OSError as exc:
            return Verdict(ready=False, detail=f"Cannot write in {folder}: {exc.strerror or exc}.")
        return Verdict(ready=True)

    @setup_step("install")
    async def _install(self, *, check: bool, values: Mapping[str, str]) -> ReturnedValue:
        """Google Drive for desktop on this computer. The run downloads Google's installer and opens it --
        the system asks the person for their password there, never us."""
        if installed():
            return ReturnedValue.satisfied("Google Drive for desktop is installed")
        if check:
            return ReturnedValue.not_yet("Google Drive for desktop is not installed")
        return await asyncio.to_thread(_open_installer)

    @setup_step("sign-in")
    async def _sign_in(self, *, check: bool, values: Mapping[str, str]) -> ReturnedValue:
        """Drive for desktop running, signed in and starting with the computer; done once My Drive is here."""
        root = my_drive(self.binding.config)
        if root is not None:
            return ReturnedValue.satisfied(f"My Drive is at {root}")
        if check:
            return ReturnedValue.not_yet("Sign in to Google Drive for desktop")
        await asyncio.to_thread(_start_app)
        return ReturnedValue.not_yet("Sign in in the Google Drive window that opened; this step finishes when My Drive appears")

    @setup_step("folder")
    async def _make_folder(self, *, check: bool, values: Mapping[str, str]) -> ReturnedValue:
        """The source's folder in My Drive (made when missing)."""
        root = my_drive(self.binding.config)
        if root is None:
            return ReturnedValue.not_yet("My Drive is not on this computer yet")
        folder = root.joinpath(*_segments(self.binding.config.get("path") or ""))
        if not folder.is_dir():
            if check:
                return ReturnedValue.not_yet(f"My Drive has no folder {self.binding.config.get('path')!r} yet")
            folder.mkdir(parents=True, exist_ok=True)
        return ReturnedValue.satisfied(str(folder))


def _open_installer() -> ReturnedValue:
    if sys.platform == "darwin":
        work = Path(tempfile.mkdtemp(prefix="gdrive-install-"))
        image = work / "GoogleDrive.dmg"
        subprocess.run(["curl", "-fsSL", "-o", str(image), MAC_INSTALLER_URL], check=True, timeout=600)
        mounted = work / "volume"
        subprocess.run(["hdiutil", "attach", "-nobrowse", "-quiet", "-mountpoint", str(mounted), str(image)],
                       check=True, timeout=120)
        package = next(mounted.glob("*.pkg"), None)
        if package is None:
            return ReturnedValue.not_yet("Google's installer image holds no package")
        subprocess.run(["open", str(package)], check=True, timeout=30)   # the system installer asks for the password
        return ReturnedValue.not_yet("The Google Drive installer is open: finish it, then this step completes by itself")
    if sys.platform == "win32":
        if shutil.which("winget") is None:
            return ReturnedValue.not_yet("Install Google Drive for desktop from google.com/drive/download")
        subprocess.Popen(["winget", "install", "--id", "Google.GoogleDrive", "-e"])  # noqa: S603, S607
        return ReturnedValue.not_yet("The Google Drive installer is running: finish it, then this step completes by itself")
    return ReturnedValue.not_yet("Google Drive for desktop runs on macOS and Windows; use the Google Drive (API) driver here")


def _start_app() -> None:
    if sys.platform == "darwin":
        subprocess.run(["defaults", "write", SETTINGS_DOMAIN, "AutoStartOnLogin", "-bool", "true"], check=False, timeout=10)
        subprocess.run(["open", "-a", str(MAC_APP)], check=False, timeout=30)
    elif sys.platform == "win32":
        exe = next(WINDOWS_APP.glob("*/GoogleDriveFS.exe"), None)
        if exe is not None:
            subprocess.Popen([str(exe)])  # noqa: S603


__all__ = ["MountedDriveSource", "installed", "my_drive"]
