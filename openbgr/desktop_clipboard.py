"""
Native OS clipboard mixin (`ClipboardMixin`) for `DesktopApi`: probes whether
the system clipboard holds an image, reads clipboard images or copied image
files as base64 PNGs, and writes RGBA PNG bytes to the clipboard.
"""

from __future__ import annotations

import base64
import io
import platform
import shutil
import subprocess
from pathlib import Path
from typing import Any

from PIL import Image

from .quick_action_native import copy_png_bytes_to_clipboard
from .settings import IMAGE_EXTENSIONS

# Common image-data UTI types on the macOS pasteboard. Anything outside this
# set falls back to NSImage.canInitWithPasteboard_ for fringe formats.
_PASTEBOARD_IMAGE_UTIS = frozenset(
    {
        "public.png",
        "public.tiff",
        "public.jpeg",
        "public.webp",
        "public.heic",
        "public.heif",
        "com.compuserve.gif",
        "com.microsoft.bmp",
    }
)
_PASTEBOARD_FILE_TYPES = frozenset({"NSFilenamesPboardType", "public.file-url"})


class ClipboardMixin:
    """Native clipboard read/write/probe methods mixed into `DesktopApi`."""

    # Safety cap for base64 bridge payloads (clipboard reads and Save-As
    # writes). File picks use file_id grants streamed over HTTP, uncapped.
    OPEN_DIALOG_MAX_BYTES: int = 48 * 1024 * 1024
    _clip_seq: Any
    _clip_has_image: bool | None

    def _decode_bounded_base64(self, data_base64: str) -> bytes:
        """Decodes base64 after enforcing `OPEN_DIALOG_MAX_BYTES` on the encoded length."""
        max_b64_len = (self.OPEN_DIALOG_MAX_BYTES * 4) // 3 + 64
        if len(data_base64) > max_b64_len:
            raise ValueError("Payload exceeds the 48 MB bridge limit.")
        return base64.b64decode(data_base64)

    @staticmethod
    def _macos_clipboard_paths() -> list[str]:
        """Returns file paths on the macOS pasteboard (Finder copies), or []."""
        try:
            import AppKit

            pb = AppKit.NSPasteboard.generalPasteboard()
            paths = [str(p) for p in (pb.propertyListForType_("NSFilenamesPboardType") or [])]
            if not paths:
                url_str = pb.stringForType_("public.file-url")
                if url_str:
                    from urllib.parse import unquote, urlparse

                    paths = [unquote(urlparse(url_str).path)]
            return paths
        except Exception:
            return []

    def copy_image(self, data_base64: str) -> dict[str, Any]:
        """
        Writes a base64-encoded 32-bit RGBA PNG directly to the native OS clipboard
        across macOS (NSPasteboard), Windows (.NET Clipboard), and Linux (wl-copy/xclip).
        """
        try:
            raw_bytes = self._decode_bounded_base64(data_base64)
            return copy_png_bytes_to_clipboard(raw_bytes)
        except Exception as exc:
            return {"copied": False, "error": str(exc)}

    def has_clipboard_image(self) -> dict[str, Any]:
        """
        Probes whether the native OS clipboard currently holds an image or an
        image file path, without triggering browser clipboard permission prompts.
        """
        sys_name = platform.system()

        if sys_name == "Darwin":
            try:
                import AppKit

                pb = AppKit.NSPasteboard.generalPasteboard()
                seq: Any = pb.changeCount()
                if seq == self._clip_seq:
                    return {"has_image": self._clip_has_image}
                types = set(pb.types() or [])
                if types & _PASTEBOARD_IMAGE_UTIS:
                    has_image: bool | None = True
                elif types & _PASTEBOARD_FILE_TYPES:
                    has_image = any(
                        Path(str(p)).is_file() and Path(str(p)).suffix.lower() in IMAGE_EXTENSIONS
                        for p in self._macos_clipboard_paths()
                    )
                else:
                    has_image = bool(AppKit.NSImage.canInitWithPasteboard_(pb))
                self._clip_seq, self._clip_has_image = seq, has_image
                return {"has_image": has_image}
            except Exception:
                pass

        seq = None
        if sys_name == "Windows":
            try:
                import ctypes

                windll = getattr(ctypes, "windll", None)
                seq = windll.user32.GetClipboardSequenceNumber() if windll is not None else None
                if seq is not None and seq == self._clip_seq:
                    return {"has_image": self._clip_has_image}
            except Exception:
                seq = None

        try:
            from PIL import ImageGrab

            grabbed = ImageGrab.grabclipboard()
            if isinstance(grabbed, Image.Image):
                grabbed.close()
                has_result: bool | None = True
            elif isinstance(grabbed, (list, tuple)):
                has_result = any(
                    Path(str(item)).is_file() and Path(str(item)).suffix.lower() in IMAGE_EXTENSIONS
                    for item in grabbed
                )
            elif sys_name in ("Darwin", "Windows"):
                has_result = False
            else:
                has_result = None
            if has_result is not None:
                if seq is not None:
                    self._clip_seq, self._clip_has_image = seq, has_result
                return {"has_image": has_result}
        except Exception:
            pass

        if platform.system() == "Linux":
            for cmd in (
                ["wl-paste", "--list-types"],
                ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
            ):
                if shutil.which(cmd[0]):
                    try:
                        proc = subprocess.run(
                            cmd,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL,
                            text=True,
                            timeout=2,
                        )
                        if proc.returncode == 0 and proc.stdout:
                            return {"has_image": "image/png" in proc.stdout.lower()}
                    except Exception:
                        pass

        return {"has_image": None}

    def read_clipboard_image(self) -> dict[str, Any]:
        """
        Reads an image (or an image file copied in Finder / File Explorer) from
        the native OS clipboard and returns it as base64 PNG bytes.
        """
        try:
            from PIL import ImageGrab

            grabbed = ImageGrab.grabclipboard()
            if isinstance(grabbed, Image.Image):
                buf = io.BytesIO()
                try:
                    grabbed.save(buf, format="PNG")
                    return {
                        "has_image": True,
                        "name": "CLIPBOARD.PNG",
                        "data_b64": base64.b64encode(buf.getvalue()).decode("ascii"),
                    }
                finally:
                    buf.close()
                    grabbed.close()

            if isinstance(grabbed, (list, tuple)):
                for item in grabbed:
                    p = Path(str(item))
                    if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS:
                        data = p.read_bytes()
                        if len(data) <= self.OPEN_DIALOG_MAX_BYTES:
                            return {
                                "has_image": True,
                                "name": p.name,
                                "data_b64": base64.b64encode(data).decode("ascii"),
                            }
        except Exception:
            pass

        if platform.system() == "Darwin":
            for item in self._macos_clipboard_paths():
                p = Path(str(item))
                if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS:
                    data = p.read_bytes()
                    if len(data) <= self.OPEN_DIALOG_MAX_BYTES:
                        return {
                            "has_image": True,
                            "name": p.name,
                            "data_b64": base64.b64encode(data).decode("ascii"),
                        }

        if platform.system() == "Linux":
            for cmd in (
                ["wl-paste", "--type", "image/png"],
                ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
            ):
                if shutil.which(cmd[0]):
                    try:
                        proc = subprocess.run(
                            cmd,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL,
                            timeout=3,
                        )
                        if proc.returncode == 0 and proc.stdout:
                            return {
                                "has_image": True,
                                "name": "CLIPBOARD.PNG",
                                "data_b64": base64.b64encode(proc.stdout).decode("ascii"),
                            }
                    except Exception:
                        pass

        return {"has_image": False}
