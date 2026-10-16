#!/usr/bin/env python3
"""
Installs a macOS Finder Quick Action: right-click an image →
Quick Actions → "Remove Background with OpenBGR".

Generates `~/Library/Services/Remove Background with OpenBGR.workflow` — a
standard Automator servicesMenu workflow wrapping `scripts/context_process.sh`
(which prefers the already-running local server and falls back to
`app.py --cli`). No AppleScript UI, no Xcode, no admin rights; the workflow is
a plain plist bundle written with plistlib.

Usage:
    python3 scripts/install_macos_quick_action.py           # install
    python3 scripts/install_macos_quick_action.py --remove  # uninstall
"""

from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
SERVICES_DIR = Path.home() / "Library" / "Services"
WORKFLOW_NAME = "Remove Background with OpenBGR"
WORKFLOW_DIR = SERVICES_DIR / f"{WORKFLOW_NAME}.workflow"

MENU_TITLE = "Remove Background with OpenBGR"
BUNDLE_ID = "com.markoshaq.openbgr.remove-background"

# Candidates checked at runtime, in order: the release .app payload (when the
# user dragged OpenBGR.app into /Applications) and this source checkout.
CONTEXT_SCRIPT_CANDIDATES = [
    "/Applications/OpenBGR.app/Contents/Resources/app/scripts/context_process.sh",
    str(Path.home() / "Applications/OpenBGR.app/Contents/Resources/app/scripts/context_process.sh"),
    str(ROOT_DIR / "scripts" / "context_process.sh"),
]

SHELL_COMMAND = "\n".join(
    [
        'for CTX in "$@CANDIDATES@"; do',
        '  if [ -f "$CTX" ]; then',
        '    exec bash "$CTX" "$@"',
        "  fi",
        "done",
        'echo "OpenBGR context_process.sh not found" >&2',
        "exit 1",
    ]
).replace(
    '"$@CANDIDATES@"',
    " ".join(f'"{p}"' for p in CONTEXT_SCRIPT_CANDIDATES),
)


def build_document_wflow() -> dict:
    """Returns the plist structure for `Contents/document.wflow`."""
    return {
        "AMApplicationBuild": "523",
        "AMApplicationVersion": "2.10",
        "AMDocumentVersion": "2",
        "actions": [
            {
                "action": {
                    "AMAccepts": {
                        "Container": "List",
                        "Optional": True,
                        "Types": ["com.apple.cocoa.path"],
                    },
                    "AMActionVersion": "2.0.3",
                    "AMApplication": ["Automator"],
                    "AMParameterProperties": {
                        "COMMAND_STRING": {},
                        "CheckedForUserMessages": {},
                        "inputMethod": {},
                        "shell": {},
                        "source": {},
                    },
                    "AMProvides": {
                        "Container": "List",
                        "Types": ["com.apple.cocoa.string"],
                    },
                    "ActionBundlePath": ("/System/Library/Automator/Run Shell Script.action"),
                    "ActionName": "Run Shell Script",
                    "ActionParameters": {
                        "COMMAND_STRING": SHELL_COMMAND,
                        "CheckedForUserMessages": 1,
                        "inputMethod": 1,
                        "shell": "/bin/bash",
                        "source": "",
                    },
                    "BundleIdentifier": "com.apple.RunShellScript",
                    "CFBundleVersion": "2.4",
                    "CanShowSelectedItemsWhenRun": False,
                    "CanShowWhenRun": True,
                    "Category": ["AMCategoryUtilities"],
                    "Description": {
                        "AMDescriptionHideAll": False,
                        "AMDescriptionHideWarning": True,
                    },
                    "Keywords": ["Shell", "Script", "Command", "Run", "Unix"],
                    "MaybeUIDataIsEncoded": True,
                    "OutputUUID": "A1B2C3D4-0000-0000-0000-000000000000",
                    "UUID": "A1B2C3D4-1111-0000-0000-000000000000",
                    "UnlockedApplications": [],
                    "Warnings": [],
                    "isViewVisible": 1,
                },
                "actionLabel": "",
                "isAsync": False,
                "isViewVisible": False,
                "location": "309.000000:316.000000",
                "showRunWhenDone": False,
            }
        ],
        "connectors": {},
        "globalMetaData": {"userInvisible": False},
        "importFileTypes": ["com.apple.Automator.fileSystemObject"],
        "importTypes": ["com.apple.Automator.fileSystemObject"],
        "libraryVersion": "1.0",
        "majorVersion": 1,
        "minorVersion": 0,
        "responseActions": [],
        "responseVariables": [],
        "variables": [],
        "workflowMetaData": {
            "applicationBundleIDsByPath": {},
            "applicationPaths": [],
            "inputTypeIdentifier": "com.apple.Automator.fileSystemObject",
            "outputTypeIdentifier": "com.apple.Automator.nothing",
            "presentationMode": 15,
            "processesInput": True,
            "serviceInputTypeIdentifier": "com.apple.Automator.fileSystemObject",
            "serviceOutputTypeIdentifier": "com.apple.Automator.nothing",
            "serviceProcessesInput": True,
            "systemImageName": "NSActionTemplate",
            "useAutomaticInputType": False,
            "workflowTypeIdentifier": "com.apple.Automator.servicesMenu",
        },
    }


def build_info_plist() -> dict:
    """Returns the plist structure for `Contents/Info.plist` (NSServices entry)."""
    return {
        "CFBundleDevelopmentRegion": "en",
        "CFBundleIdentifier": BUNDLE_ID,
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": WORKFLOW_NAME,
        "CFBundlePackageType": "BNDL",
        "CFBundleShortVersionString": "1.0",
        "CFBundleVersion": "1.0",
        "NSServices": [
            {
                "NSMenuItem": {"default": MENU_TITLE},
                "NSMessage": "runWorkflowAsService",
                "NSRequiredContext": {},
                "NSSendFileTypes": ["public.image"],
            }
        ],
    }


def install() -> int:
    """Writes the workflow bundle and asks pbs to rescan services."""
    contents = WORKFLOW_DIR / "Contents"
    contents.mkdir(parents=True, exist_ok=True)
    with open(contents / "Info.plist", "wb") as fh:
        plistlib.dump(build_info_plist(), fh)
    with open(contents / "document.wflow", "wb") as fh:
        plistlib.dump(build_document_wflow(), fh)

    # Refresh the services/Quick Actions registry so the item shows up without
    # needing to log out.
    for pbs in (
        "/System/Library/CoreServices/pbs",
        "/System/Library/CoreServices/pbsd",
    ):
        if os.path.exists(pbs):
            subprocess.run([pbs, "-flush"], check=False, capture_output=True)
            break

    print(f"[Done] Installed Quick Action → {WORKFLOW_DIR}")
    print("       Right-click an image in Finder → Quick Actions →")
    print(f'       "{MENU_TITLE}".')
    print("       (If it doesn't appear immediately, toggle it on in")
    print("        System Settings → Keyboard → Keyboard Shortcuts → Services.)")
    return 0


def remove() -> int:
    """Deletes the workflow bundle."""
    if WORKFLOW_DIR.exists():
        shutil.rmtree(WORKFLOW_DIR)
        print(f"[Done] Removed {WORKFLOW_DIR}")
    else:
        print("[Done] Quick Action was not installed.")
    return 0


if __name__ == "__main__":
    if sys.platform != "darwin":
        print("This installer is for macOS only.")
        raise SystemExit(1)
    if "--remove" in sys.argv or "--uninstall" in sys.argv:
        raise SystemExit(remove())
    raise SystemExit(install())
