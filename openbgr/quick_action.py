"""
Quick Action / headless CLI runner: encodes cutouts to PNG/WebP/JPEG/mask,
resolves output paths, delegates to a running server when possible, and
processes image batches per the persisted Quick Action configuration.
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
from typing import Any

from PIL import Image

from .config import (
    API_TOKEN_HEADER,
    RECOMMENDED_TIER,
    TIERS,
    logger,
    normalize_tier_key,
    read_api_token,
)
from .models import MANAGER, set_job_phase
from .pipeline import segment_foreground
from .quick_action_config import load_quick_action_config
from .quick_action_native import (
    choose_output_folder_native,
    choose_save_path_native,
    copy_png_bytes_to_clipboard,
    format_quick_action_notification,
    send_openbgr_notification,
)
from .server_probe import is_openbgr_server


def cutout_filename_for(fmt: str = "png") -> tuple[str, str]:
    """Returns `(suffix_tag, ext)` for a given export format."""
    fmt_clean = (fmt or "png").strip().lower()
    if fmt_clean == "mask":
        return "mask", "png"
    if fmt_clean in ("webp", "jpg", "png"):
        return "cutout", fmt_clean
    return "cutout", "png"


def _default_output_path(src: Path, fmt: str = "png", dest_dir: Path | None = None) -> Path:
    """Returns `<stem>-cutout.<ext>` in `dest_dir` (or beside `src`), uniquified with `-N`."""
    tag, ext = cutout_filename_for(fmt)
    folder = dest_dir if dest_dir is not None else src.parent
    candidate = folder / f"{src.stem}-{tag}.{ext}"
    n = 1
    while candidate.exists():
        candidate = folder / f"{src.stem}-{tag}-{n}.{ext}"
        n += 1
    return candidate


def encode_cutout_image(rgba_img: Image.Image, fmt: str = "png") -> bytes:
    """Encodes a 32-bit RGBA cutout PIL image into PNG, WebP, JPEG (white matte), or 8-bit Mask PNG."""
    fmt_clean = (fmt or "png").strip().lower()
    buf = io.BytesIO()
    try:
        if fmt_clean == "mask":
            alpha = rgba_img.getchannel("A")
            try:
                alpha.save(buf, format="PNG", compress_level=1)
            finally:
                alpha.close()
        elif fmt_clean == "webp":
            rgba_img.save(buf, format="WEBP", lossless=True, quality=100)
        elif fmt_clean == "jpg":
            bg = Image.new("RGB", rgba_img.size, (255, 255, 255))
            alpha = rgba_img.getchannel("A")
            try:
                bg.paste(rgba_img, mask=alpha)
                bg.save(buf, format="JPEG", quality=95, subsampling=0)
            finally:
                alpha.close()
                bg.close()
        else:
            rgba_img.save(buf, format="PNG", compress_level=1)
        return buf.getvalue()
    finally:
        buf.close()


def _with_output_suffix(path: Path, ext: str) -> Path:
    """Appends `.<ext>` when the chosen output path has no file extension."""
    if not path.suffix:
        return path.with_name(f"{path.name}.{ext}")
    return path


def _resolve_cli_output(
    src: Path, output: str | None, input_count: int, fmt: str = "png"
) -> Path | None:
    """Maps `-o` semantics: omitted → sibling cutout; bare `-o` → Save dialog; else file/dir."""
    tag, ext = cutout_filename_for(fmt)
    if output is None:
        return _default_output_path(src, fmt=fmt)
    if output == "ASK":
        chosen = choose_save_path_native(f"{src.stem}-{tag}.{ext}", src.parent)
        return _with_output_suffix(chosen, ext) if chosen is not None else None
    dest = Path(output).expanduser()
    if dest.is_dir() or input_count > 1 or str(output).endswith(("/", os.sep)):
        dest.mkdir(parents=True, exist_ok=True)
        return _default_output_path(src, fmt=fmt, dest_dir=dest)
    return _with_output_suffix(dest, ext)


def delegate_quick_action_to_server(inputs: list[str]) -> dict[str, Any] | None:
    """
    If an OpenBGR server is already listening on localhost, delegates the Quick
    Action batch over HTTP so Windows context-menu invocations and CLI calls
    reuse the warm GPU/MPS model with zero cold-start overhead.
    """
    import urllib.error
    import urllib.parse
    import urllib.request

    resolved = [
        str(Path(p).expanduser().resolve()) for p in inputs if Path(p).expanduser().is_file()
    ]
    if not resolved:
        return None
    port = os.environ.get("OPENBGR_PORT") or os.environ.get("PORT") or "7860"
    api = f"http://127.0.0.1:{port}"
    try:
        if not is_openbgr_server(api, timeout_s=1.5):
            return None
        data = urllib.parse.urlencode([("files", p) for p in resolved]).encode("utf-8")
        req = urllib.request.Request(f"{api}/api/quick-action", data=data, method="POST")
        token = read_api_token()
        if token:
            req.add_header(API_TOKEN_HEADER, token)
        with urllib.request.urlopen(req, timeout=300) as res:
            payload = json.loads(res.read().decode("utf-8"))
            if isinstance(payload, dict) and ("ok" in payload or "cancelled" in payload):
                return payload
    except urllib.error.HTTPError:
        # The server answered with an error status; nothing is left running
        # server-side, so a local rerun cannot duplicate outputs.
        return None
    except Exception:
        # A timeout or dropped connection after the POST leaves the batch
        # running server-side (it runs detached via asyncio.to_thread), so a
        # local rerun would duplicate every output file. Re-probe once: a live
        # server owns the job; only a dead one makes local fallback safe.
        if is_openbgr_server(api, timeout_s=1.5):
            logger.info(
                "[QuickAction] Lost the delegated run's response; the server is still processing it."
            )
            return {"ok": True, "delegated": True}
        return None
    return None


def run_quick_action(inputs: list[str]) -> dict[str, Any]:
    """
    Processes 1 or more images selected via the OS Quick Action / context menu
    using the user's persisted Quick Action settings (`~/.openbgr/quick_action.json`):
    model preset, save location (same folder or file/folder dialog), output format,
    edge refinement, optional clipboard copy, and native OpenBGR notification.
    """
    cfg = load_quick_action_config()
    tier_key = normalize_tier_key(cfg["tier"])
    if tier_key not in TIERS:
        tier_key = RECOMMENDED_TIER
    use_matting = tier_key == "matting"
    edge_refine = bool(cfg.get("edge_refine", True))
    fmt = str(cfg.get("format", "png") or "png")
    save_mode = str(cfg.get("save_mode", "same_folder") or "same_folder")
    copy_clip = bool(cfg.get("copy_clipboard", False))
    notify = bool(cfg.get("notify", True))

    valid_sources: list[Path] = []
    failed = 0
    for src_str in inputs:
        p = Path(src_str).expanduser()
        if p.is_file():
            valid_sources.append(p)
        else:
            failed += 1

    if not valid_sources:
        logger.warning("[QuickAction] No valid input files: %s", inputs)
        return {"ok": False, "succeeded": [], "outputs": [], "failed": failed}

    # When multiple images are selected and save_mode is "ask", prompt once for
    # the destination folder so the user isn't shown N separate Save dialogs.
    batch_dest_dir: Path | None = None
    if save_mode == "ask" and len(valid_sources) > 1:
        batch_dest_dir = choose_output_folder_native(valid_sources[0].parent, len(valid_sources))
        if batch_dest_dir is None:
            return {
                "ok": True,
                "cancelled": True,
                "succeeded": [],
                "outputs": [],
                "failed": 0,
            }

    succeeded_names: list[str] = []
    outputs_written: list[str] = []
    cancelled = False

    logger.info(
        "[QuickAction] Processing %d image%s with %s (%s).",
        len(valid_sources),
        "" if len(valid_sources) == 1 else "s",
        tier_key,
        fmt,
    )
    for src in valid_sources:
        pil_img: Image.Image | None = None
        result_img: Image.Image | None = None
        try:
            pil_img = Image.open(src)
            pil_img.load()
            result_img, _elapsed_ms, _tier_cfg, _job_id = segment_foreground(
                pil_img,
                tier_key,
                edge_refine,
                edge_refine,
                use_matting,
            )

            if save_mode == "ask":
                if len(valid_sources) == 1:
                    tag, ext = cutout_filename_for(fmt)
                    chosen = choose_save_path_native(f"{src.stem}-{tag}.{ext}", src.parent)
                    if chosen is None:
                        return {
                            "ok": True,
                            "cancelled": True,
                            "succeeded": succeeded_names,
                            "outputs": outputs_written,
                            "failed": failed,
                        }
                    out_path = _with_output_suffix(chosen, ext)
                else:
                    out_path = _default_output_path(src, fmt=fmt, dest_dir=batch_dest_dir)
            else:
                out_path = _default_output_path(src, fmt=fmt)

            encoded_bytes = encode_cutout_image(result_img, fmt=fmt)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(encoded_bytes)

            if copy_clip and len(valid_sources) == 1:
                clip_bytes = (
                    encoded_bytes if fmt == "png" else encode_cutout_image(result_img, fmt="png")
                )
                copy_png_bytes_to_clipboard(clip_bytes)

            succeeded_names.append(src.name)
            outputs_written.append(str(out_path))
        except InterruptedError:
            logger.info("[QuickAction] Cancelled: %s", src.name)
            cancelled = True
            break
        except Exception:
            logger.exception("[QuickAction] Failed %s.", src.name)
            failed += 1
        finally:
            set_job_phase("idle")
            if result_img is not None:
                result_img.close()
            if pil_img is not None:
                pil_img.close()

    logger.info(
        "[QuickAction] Run complete: %d succeeded, %d failed.",
        len(succeeded_names),
        failed,
    )
    if notify:
        msg = format_quick_action_notification(succeeded_names, failed)
        if msg:
            send_openbgr_notification(msg)

    # Release cached MPS/CUDA blocks between batches; the model stays loaded so
    # subsequent runs are still warm, but idle memory pressure stays low.
    try:
        MANAGER.flush_device_memory()
    except Exception:
        pass

    return {
        "ok": failed == 0 and len(succeeded_names) > 0,
        "cancelled": cancelled,
        "succeeded": succeeded_names,
        "outputs": outputs_written,
        "failed": failed,
    }


def run_cli(
    inputs: list[str],
    output: str | None,
    tier: str | None,
    defringe: bool,
    despill: bool,
    matting: bool,
    fmt: str = "png",
) -> int:
    """
    Headless background removal for CLI / scripting use. Loads the requested
    BiRefNet tier, runs the same `segment_foreground` pipeline the web UI uses,
    and writes full-resolution cutouts. No server or window.
    """
    if not inputs:
        logger.warning("[CLI] No input files given.")
        return 2
    rc = 0
    for src_str in inputs:
        src = Path(src_str).expanduser()
        if not src.is_file():
            logger.warning("[CLI] Skipping (not a file): %s", src)
            rc = 1
            continue
        pil_img: Image.Image | None = None
        try:
            pil_img = Image.open(src)
            pil_img.load()
            result_img, elapsed_ms, tier_cfg, _job_id = segment_foreground(
                pil_img,
                tier or RECOMMENDED_TIER,
                defringe,
                despill,
                matting,
            )
            try:
                out_path = _resolve_cli_output(src, output, len(inputs), fmt=fmt)
                if out_path is None:
                    logger.info("[CLI] Save cancelled for %s", src.name)
                    continue
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_bytes(encode_cutout_image(result_img, fmt=fmt))
                logger.info(
                    "[CLI] %s -> %s (%.0f ms, %s)",
                    src.name,
                    out_path,
                    elapsed_ms,
                    tier_cfg["label"],
                )
            finally:
                result_img.close()
        except InterruptedError:
            logger.info("[CLI] Cancelled: %s", src.name)
            rc = 1
        except Exception:
            logger.exception("[CLI] Failed %s.", src.name)
            rc = 1
        finally:
            set_job_phase("idle")
            if pil_img is not None:
                pil_img.close()
    return rc
