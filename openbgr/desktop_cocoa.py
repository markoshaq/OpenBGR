"""
macOS-only Cocoa integration: app name, NSMenu/NSWindow/appearance tweaks, and
the 'odoc' AppleEvent + AppDelegate handlers that deliver "Open With" files.
"""

from __future__ import annotations

import platform
from typing import Any

from .config import APP_VERSION, logger
from .desktop_bridge import queue_open_files


def set_macos_app_name(name: str) -> None:
    """
    Renames the macOS menu-bar application name from "Python" to `name` and
    updates the bundle metadata before NSApplication finishes launching.
    """
    if platform.system() != "Darwin":
        return
    try:
        import Foundation  # type: ignore

        Foundation.NSProcessInfo.processInfo().setProcessName_(name)
        bundle = Foundation.NSBundle.mainBundle()
        for info_dict in (
            bundle.infoDictionary(),
            bundle.localizedInfoDictionary(),
        ):
            if info_dict is not None:
                info_dict["CFBundleName"] = name
                info_dict["CFBundleDisplayName"] = name
                info_dict["CFBundleShortVersionString"] = APP_VERSION
                info_dict["CFBundleVersion"] = APP_VERSION
                info_dict["CFBundleGetInfoString"] = f"{name} {APP_VERSION}"
                info_dict["NSHumanReadableCopyright"] = (
                    f"{name} - Local AI Background Removal Studio"
                )
    except Exception:
        pass


def configure_macos_native_window_and_menus(window: Any) -> None:
    """
    Enhances the macOS Cocoa NSMenu and NSWindow once the window is shown:
    1. Attaches native Cocoa keyboard shortcuts (`keyEquivalent`) to menu items
       so macOS displays `⌘T`, `⌘O`, `⌘B`, `⌘E`, `⌘W`, `⌘,`, `⇧⌘C`, `⌘+`/`⌘-`/`⌘0`,
       `⌘R`, `⌘M`, and `⌃⌘F` in the menu bar, and intercepts `⌘W` to close the
       active tab instead of closing the entire window. `⌘V` is deliberately
       left unbound: the DOM `paste` event already routes image pastes to the
       workspace, and a menu keyEquivalent would swallow text paste inside
       focused form fields.
    2. Wires the top "About OpenBGR" item in the macOS application menu to open
       the in-app About / System Info dialog.
    3. Sets the NSWindow appearance to DarkAqua by default.
    """
    if platform.system() != "Darwin":
        return

    def _enhance() -> None:
        """Deferred post-show enhancement; imports Cocoa lazily and fails soft."""
        try:
            import AppKit  # type: ignore
            import webview.platforms.cocoa as cocoa_mod  # type: ignore
            from PyObjCTools import AppHelper  # type: ignore

            def _on_main() -> None:
                """Applies dark appearance, gesture config, and menu shortcuts on the main run loop."""
                try:
                    ns_win = getattr(window, "native", None)
                    if ns_win is not None:
                        dark = AppKit.NSAppearance.appearanceNamed_(AppKit.NSAppearanceNameDarkAqua)
                        if dark is not None:
                            ns_win.setAppearance_(dark)

                        # Keep trackpad pinch available to JS GestureEvents by
                        # disabling WKWebView's page-level magnification.
                        def _find_wkwebview(view: Any) -> Any:
                            """Depth-first search for the WKWebView inside the window's view tree."""
                            if view is None:
                                return None
                            try:
                                if str(view.className()) == "WKWebView":
                                    return view
                                for sub in view.subviews():
                                    found = _find_wkwebview(sub)
                                    if found is not None:
                                        return found
                            except Exception:
                                return None
                            return None

                        wk_view = _find_wkwebview(ns_win.contentView())
                        if wk_view is not None:
                            try:
                                wk_view.setAllowsMagnification_(False)
                                wk_view.setMagnification_(1.0)
                            except Exception:
                                pass

                    main_menu = AppKit.NSApplication.sharedApplication().mainMenu()
                    if main_menu is None:
                        return

                    cmd_mask = AppKit.NSEventModifierFlagCommand
                    shift_cmd = cmd_mask | AppKit.NSEventModifierFlagShift
                    ctrl_cmd = cmd_mask | AppKit.NSEventModifierFlagControl

                    shortcuts: dict[str, tuple[str, int]] = {
                        "Preferences…": (",", cmd_mask),
                        "New Tab": ("t", cmd_mask),
                        "Open Image…": ("o", cmd_mask),
                        "Batch Process Images…": ("b", cmd_mask),
                        "Export Image…": ("e", cmd_mask),
                        "Close Tab": ("w", cmd_mask),
                        "Reopen Closed Tab": ("t", shift_cmd),
                        "Copy Cutout": ("c", shift_cmd),
                        "Zoom In": ("+", cmd_mask),
                        "Zoom Out": ("-", cmd_mask),
                        "Actual Size": ("0", cmd_mask),
                        "Re-Run Segmentation": ("r", cmd_mask),
                        "Minimize": ("m", cmd_mask),
                        "Toggle Full Screen": ("f", ctrl_cmd),
                    }

                    # Wire "About OpenBGR" in the app menu (index 0) to our in-app About modal
                    app_menu_item = main_menu.itemAtIndex_(0)
                    if app_menu_item and app_menu_item.submenu():
                        app_sub = app_menu_item.submenu()
                        if app_sub.numberOfItems() > 0:
                            about_item = app_sub.itemAtIndex_(0)
                            about_id = "openbgr.about"
                            cocoa_mod.menu_handler.register_action(
                                about_id,
                                lambda: window.evaluate_js(
                                    "window.openBGR && window.openBGR.openSettings('about')"
                                ),
                            )
                            about_item.setTitle_("About OpenBGR")
                            about_item.setAction_("handleMenuAction:")
                            about_item.setTarget_(cocoa_mod.menu_handler)
                            about_item.setRepresentedObject_(about_id)

                    for i in range(main_menu.numberOfItems()):
                        top_item = main_menu.itemAtIndex_(i)
                        sub = top_item.submenu() if top_item else None
                        if sub is None:
                            continue
                        for j in range(sub.numberOfItems()):
                            mi = sub.itemAtIndex_(j)
                            if mi is None:
                                continue
                            title = str(mi.title() or "")
                            if title in shortcuts:
                                key_eq, mask = shortcuts[title]
                                mi.setKeyEquivalent_(key_eq)
                                mi.setKeyEquivalentModifierMask_(mask)
                except Exception:
                    pass

            AppHelper.callAfter(_on_main)
        except Exception:
            pass

    try:
        window.events.shown += lambda *a, **k: _enhance()
    except Exception:
        pass


def install_macos_open_documents_handler() -> None:
    """
    Registers a Cocoa AppleEvent handler so `open -a OpenBGR file.png`, Finder's
    "Open With", and drops onto the Dock icon deliver image paths to the app.
    macOS routes these through the 'odoc' AppleEvent rather than argv.
    """
    if platform.system() != "Darwin":
        return
    try:
        import Foundation  # type: ignore

        kae_open_docs = int.from_bytes(b"odoc", "big")
        kae_core_class = int.from_bytes(b"aevt", "big")
        key_direct_object = int.from_bytes(b"----", "big")
        type_file_url = int.from_bytes(b"furl", "big")

        def _desc_to_path(desc: Any) -> str | None:
            """Extracts a filesystem path from an odoc descriptor (alias/furl/URL)."""
            if desc is None:
                return None
            candidates = [desc]
            if desc.descriptorType() != type_file_url:
                try:
                    coerced = desc.coerceToDescriptorType_(type_file_url)
                    if coerced is not None:
                        candidates.insert(0, coerced)
                except Exception:
                    pass
            for cand in candidates:
                try:
                    url = cand.fileURLValue()
                    if url is not None and url.path():
                        return str(url.path())
                except Exception:
                    pass
                try:
                    url = Foundation.NSURL.URLWithString_(cand.stringValue())
                    if url is not None and url.path():
                        return str(url.path())
                except Exception:
                    pass
            return None

        class _OpenDocsHandler(Foundation.NSObject):  # type: ignore
            def handleOpenDocuments_withReplyEvent_(self, event, reply):
                """Parses 'odoc' file descriptors and queues the image paths."""
                paths: list[str] = []
                logger.info("[Desktop] odoc AppleEvent received")
                try:
                    direct = event.paramDescriptorForKeyword_(key_direct_object)
                    count = int(direct.numberOfItems()) if direct is not None else 0
                    for i in range(1, count + 1):
                        p = _desc_to_path(direct.descriptorAtIndex_(i))
                        if p:
                            paths.append(p)
                except Exception as exc:
                    logger.warning("[Desktop] odoc parse failed (%s)", exc)
                if paths:
                    logger.info("[Desktop] odoc paths: %s", paths)
                    queue_open_files(paths)

        mgr = Foundation.NSAppleEventManager.sharedAppleEventManager()
        retained: list[Any] = []
        install_macos_open_documents_handler._retained = retained  # type: ignore[attr-defined]

        def _register() -> None:
            handler = _OpenDocsHandler.alloc().init()
            mgr.setEventHandler_andSelector_forEventClass_andEventID_(
                handler,
                b"handleOpenDocuments:withReplyEvent:",
                kae_core_class,
                kae_open_docs,
            )
            retained.append(handler)

        _register()

        # AppKit installs its own 'odoc' handler while NSApplication finishes
        # launching (it forwards to the app delegate, which pywebview does not
        # implement for openFiles:); re-register ours once that happens so the
        # event dispatches to us, both at launch and for "Open With" while running.
        class _LaunchObserver(Foundation.NSObject):  # type: ignore
            def didFinishLaunching_(self, _notif):
                """Re-registers our 'odoc' handler once NSApplication finishes launching."""
                _register()

        observer = _LaunchObserver.alloc().init()
        retained.append(observer)
        Foundation.NSNotificationCenter.defaultCenter().addObserver_selector_name_object_(
            observer,
            b"didFinishLaunching:",
            "NSApplicationDidFinishLaunchingNotification",
            None,
        )
        logger.info("[Desktop] Open-Documents handler installed.")
    except Exception as exc:
        logger.warning("[Desktop] Open-Documents handler unavailable (%s).", exc)


def install_macos_open_files_delegate() -> None:
    """
    Subclasses pywebview's Cocoa `AppDelegate` before `webview.create_window`
    instantiates it, adding `application:openFiles:` / `openFile:` / `openURLs:`.
    AppKit forwards 'odoc' AppleEvents (Finder "Open With", Dock drops,
    `open -a App file`) to these delegate methods, including the launch-time
    event that the AppleEvent-manager path alone can miss.
    """
    if platform.system() != "Darwin":
        return
    try:
        import webview.platforms.cocoa as cocoa_mod  # type: ignore

        base_delegate = cocoa_mod.BrowserView.AppDelegate

        class _OpenFilesDelegate(base_delegate):  # type: ignore
            def application_openFiles_(self, _app, filenames):
                """Handles 'Open With' / Dock drops delivering multiple file paths."""
                queue_open_files([str(f) for f in filenames])

            def application_openFile_(self, _app, filename):
                """Handles the single-file variant of the open-documents delegate call."""
                queue_open_files([str(filename)])
                return True

            def application_openURLs_(self, _app, urls):
                """Handles open-requests that arrive as file URLs instead of paths."""
                paths = [str(p) for u in urls if (p := u.path()) is not None]
                if paths:
                    queue_open_files(paths)

        cocoa_mod.BrowserView.AppDelegate = _OpenFilesDelegate  # type: ignore[misc]
        logger.info("[Desktop] Open-Files delegate installed.")
    except Exception as exc:
        logger.warning("[Desktop] Open-Files delegate unavailable (%s).", exc)
