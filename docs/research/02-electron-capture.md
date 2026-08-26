# Electron Screen-Share Publisher: 2026 State of the Art

> Research report produced 2026-08-26. Scope: building the Electron publisher app —
> capture APIs, per-OS backends, quality control, tray/desktop UX, toolchain, and
> reference implementations.

## Key facts

| Thing | Value (verified Aug 26, 2026) |
|---|---|
| Electron stable | **44.0.0** (rel. Aug 24, 2026) — Chromium 152.0.7977.54, Node 24.18.1, V8 15.2 |
| Supported majors | **44, 43, 42** (latest three only) — 43 = Chromium 150 / Node 24.17.0; 42 = Chromium 148 / Node 24.18.1 |
| Cadence | Major every 8 weeks, 4wk alpha + 4wk beta |
| Modern capture API | `session.setDisplayMediaRequestHandler()` + `navigator.mediaDevices.getDisplayMedia()` |
| Source enumeration | `desktopCapturer.getSources({types, thumbnailSize, fetchWindowIcons})` — **main process only** |
| macOS system picker | `{ useSystemPicker: true }` — macOS 15+, still flagged **Experimental** |
| Toolchain versions | `@electron-forge/cli` 7.11.2 · `electron-builder` 26.15.3 · `electron-vite` 5.0.0 · `electron-updater` 6.8.9 · `@electron/packager` 20.3.0 · `@electron/notarize` 3.1.1 · `@electron/osx-sign` 2.7.0 |
| Best reference impl | `@jitsi/electron-sdk` **10.0.4** (Apache-2.0, actively maintained) |

Version history of the capture API:

- **Electron 17** (Chromium 98, Feb 2022) — `desktopCapturer.getSources` restricted to the main process; `webContents.getMediaSourceId()` added.
- **Electron 22** — `session.setDisplayMediaRequestHandler` added (PR #30702, merged Aug 22 2022; author confirms "this is in v22").
- **Electron 23.2** — `enableLocalEcho` callback flag (PR #37315).
- **Electron 32/33** — `useSystemPicker` + `desktopCapturer.isDisplayMediaSystemPickerAvailable()` (PR #43581, merged Sep 10 2024). Explicitly a stopgap ahead of Chromium's own M130+ support.
- **Electron 39** — Chromium switched to Apple's CoreAudio Tap API by default, so `NSAudioCaptureUsageDescription` in `Info.plist` became **mandatory** for desktop audio.

---

## 1. Screen capture: the modern path

**Use `setDisplayMediaRequestHandler` + `getDisplayMedia`.** The old `getUserMedia({video:{mandatory:{chromeMediaSource:'desktop', chromeMediaSourceId}}})` trick has been fully removed from the current desktopCapturer docs — the only example shown now is the `getDisplayMedia` path. Treat the legacy path as unsupported.

**Yes, you can build a fully custom picker** on Windows, macOS, and X11. The wiring is:

1. Renderer calls `navigator.mediaDevices.getDisplayMedia({video:true, audio:true})`.
2. Main's handler fires. **Do not resolve it yet** — stash the `callback` and open your own picker UI.
3. Your picker (a `BrowserWindow`, or an in-app modal) asks main for `desktopCapturer.getSources({types:['screen','window'], thumbnailSize:{...}, fetchWindowIcons:true})` over IPC. You get `id`, `name`, `thumbnail` (a `NativeImage` → serialize with `.toDataURL()`), `display_id`, and `appIcon`.
4. User picks; you invoke the stashed `callback({ video: chosenSource, audio: 'loopback' })`.

`callback` accepts `video` as either a `WebFrameMain` (self-capture) or `{id, name}` from a `DesktopCapturerSource`; `audio` as `'loopback'`, `'loopbackWithMute'`, or a `WebFrameMain`.

The most important structural detail, which the naive tutorials get wrong and Jitsi gets right: **key the pending callbacks by request ID**. The pattern from `@jitsi/electron-sdk`'s `screensharing/main.js`:

```js
const requestId = ++this._gdmRequestId;
this._pendingGdmRequests.set(requestId, { request, callback });
this._jitsiMeetWindow.webContents.send(SCREEN_SHARE_EVENTS_CHANNEL, {
  data: { name: SCREEN_SHARE_EVENTS.OPEN_PICKER, requestId }
});
```

Concurrent `getDisplayMedia()` calls otherwise clobber each other. Also note there are open bugs (#47980, #45517) about the handler needing to cope with exceptions and user cancellation — you must always call the callback, including on cancel.

On the **system picker**: it's macOS-15-only and still experimental. Jitsi ships it *off* with an explicit `// TODO: enable this when not experimental` comment. There's a known hang bug when toggling it on/off/on (#45306). Since a custom picker is our product requirement anyway, leave `useSystemPicker: false`. One caveat: `isDisplayMediaSystemPickerAvailable()` exists in `lib/browser/api/desktop-capturer.ts` but is **not** on the published docs page — it's effectively undocumented API.

---

## 2. Per-OS backends and gotchas

### Linux/Wayland — this is the one that breaks our design

On Wayland, capture goes through PipeWire + `xdg-desktop-portal`, and **the portal owns the picker UI**. The compositor's backend (GNOME, KDE, wlroots) draws it, not us. Electron's docs state it plainly: *"desktopCapturer.getSources(options) only returns a single source on Linux when using Pipewire"* — because by the time you call it, the user has already chosen via the portal dialog, and you just receive the result.

So our custom picker **cannot exist on Wayland**. We must branch. Jitsi's exact approach:

```js
const isWayland = () => process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
```

…and on Wayland, skip the custom picker entirely, call `getSources({types:['screen','window']})`, and take `sources[0]`. Note also that if you request both `window` and `screen` types, the returned source is reported as a **window** capture regardless of what the user actually picked.

X11 still behaves like Windows/macOS (full enumeration with thumbnails), so "Linux" isn't monolithic — we need the session-type check, not a platform check. Electron PR #39111 moved the implementation to WebRTC's `CreateGenericCapturer` so screens and windows come through one portal request instead of two permission prompts.

Wayland thumbnail generation and premature portal timeouts were being actively fixed in the 43–44 cycle, so pin recent Electron if we support Linux.

### macOS

Screen capture requires TCC "Screen Recording" consent on 10.15+. Two hard-won gotchas:

- `systemPreferences.getMediaAccessStatus('screen')` is **read-only — it does not register your binary with TCC**. The app won't even appear in System Settings until you actually attempt a capture. The trick is to call `desktopCapturer.getSources({types:['screen'], thumbnailSize:{width:1,height:1}})` once to force registration.
- The status is **cached**; it can keep returning `denied` after the user grants permission (#36722, #35025). Practically, macOS requires an app restart after granting. Jitsi's escape hatch is to shell out to `tccutil reset ScreenCapture <bundleId>` when permission isn't granted, forcing a fresh prompt.

For **audio**: `NSAudioCaptureUsageDescription` is required in `Info.plist` as of Electron 39 (CoreAudio Tap by default). Without it you get a *silent* stream, not an error — a nasty failure mode. You can fall back to the old path with `app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare')`. On macOS ≤12.7.6 loopback audio is simply impossible (needs a signed kext) — moot now that **Electron 44 requires macOS 13+**.

There is **no entitlement for screen recording** — it's pure runtime TCC. For hardened runtime you need `com.apple.security.cs.allow-jit` and `allow-unsigned-executable-memory` (standard Electron), plus `NSCameraUsageDescription`/`NSMicrophoneUsageDescription` if we touch those.

Unconfirmed from primary sources: exactly which Chromium milestone made ScreenCaptureKit the default macOS backend. Chromium has `content/browser/media/capture/screen_capture_kit_device_mac.mm` dating to 2022 (~M105), and ScreenCaptureKit requires macOS 12.3+, but treat "which backend am I on" as something to verify empirically rather than assume.

### Windows

Same caveat, more strongly: **could not verify whether Chromium currently defaults to WGC (Windows.Graphics.Capture) or DXGI Desktop Duplication.** Searches turned up only that WGC window capture was rolled out as a Finch experiment while DXGI remained the screen-capture default. Flagged as an open question worth an empirical test on our target Electron build.

What is well-established about the tradeoff: WGC captures per-window correctly even when occluded or partially offscreen and handles hardware-accelerated/GPU content that GDI misses, but it **draws a yellow border** around the captured window. That border is a Windows-level behavior controllable via `GraphicsCaptureSession.IsBorderRequired` (Win11 22000+, and disabling it requires a special capability), not something Electron exposes. If users report a yellow border, that's WGC and it's not our bug. Windows also has a long tail of black-frame bugs capturing content-protected or hardware-accelerated windows.

Chromium **auto-throttles** capture independent of our constraints: it monitors GPU/encoder/buffer-pool/network utilization and steps resolution down through a fixed ladder, at most once every three seconds. Frame rate isn't throttled directly but degrades indirectly. Notably, the design doc admits it has *no signal* for compositor overload, so on weak machines you can silently drop frames with no adaptation. Budget for the fact that we don't fully control output resolution.

---

## 3. Capture quality control

**The big constraint gotcha: `getDisplayMedia()` rejects `min` and `exact`.** Per MDN, *"`min` and `exact` values are not permitted in constraints used in `getDisplayMedia()` calls"* — a `TypeError` if you try. Only `ideal` (or bare values) are allowed, and the spec is explicit that constraints *"must be applied after the user chooses a source"* — they cannot filter what the user sees.

Practically this means: **we always capture at native resolution and downscale afterward.** Our resolution/fps requests are advisory hints that Chromium applies as post-selection scaling. So capture-native-then-downscale-in-encoder is not just the norm, it's the only available model. For a 720p/1080p/native × 15/30/60fps quality matrix, plan to:

- Pass `{ width: {ideal}, height: {ideal}, frameRate: {ideal} }` to `getDisplayMedia`.
- Enforce the real ceiling downstream — WebRTC `RTCRtpSender.setParameters()` with `scaleResolutionDownBy` / `maxFramerate` / `maxBitrate`, or encoder settings — because the constraint alone won't hold.
- Use `track.applyConstraints()` to change quality mid-session without re-prompting.

Reported `frameRate` capability for screen capture maxes at 30 in several implementations, and there are long-standing complaints that actual delivered fps lands well below what `track.getSettings()` claims. **60fps screen capture should be treated as unproven until we measure it.**

**`contentHint` is cheap and worth setting.** On the video track: `'text'` or `'detail'` makes the encoder favor spatial sharpness over smoothness (right for code, docs, slides); `'motion'` favors framerate (right for video playback or games). Default `''` gives generic behavior. Set it right after acquiring the track, and feature-detect with `if ('contentHint' in track)`.

Other `getDisplayMedia` options relevant to us: `systemAudio: 'include'|'exclude'`, `monitorTypeSurfaces`, `surfaceSwitching`, `selfBrowserSurface`, `suppressLocalAudioPlayback`. Electron 44 also fixed `getDisplayMedia({audio:{restrictOwnAudio:true}})` being ignored, which matters if we don't want our own app's audio in the loopback mix.

---

## 4. Tray and desktop-integration UX

The Tray platform matrix is genuinely uneven:

**Linux is the weak platform.** `right-click`, `double-click`, `popUpContextMenu()`, `closeContextMenu()`, and `getBounds()` are **all unsupported**. Only `click`, `setImage`, `setToolTip`, `setContextMenu` work. Tray uses StatusNotifierItem where available, falling back to GtkStatusIcon; whether `click` means left-click or double-click *varies by desktop environment*. And changing menu items requires calling `setContextMenu()` again — mutating the existing Menu object does nothing. Electron 44 fixed tray icons not appearing at all on GNOME/Cinnamon/XFCE with StatusNotifierItem, so pin ≥44 if Linux matters.

**macOS**: `setContextMenu()` **swallows mouse events** — the docs state mouse events "will not be emitted if you have set a context menu for your Tray". So we cannot have both a left-click action and a right-click menu the naive way; use `popUpContextMenu()` manually from the `right-click` handler instead. Icons must be **template images**: filename must end in `Template`, with a matching `@2x`; 16×16 @72dpi + 32×32 @2x @144dpi is the recommended pair. `setTitle()` (menu-bar text label) is macOS-only — handy for a live "● REC 03:12" indicator; on Windows/Linux we'd swap the icon instead.

**Windows**: use `.ico` for best results. Supports `right-click`, `double-click`, `middle-click`, balloons, `focus()`. The `guid` option persists tray position across updates — but for **unsigned** apps the GUID binds to the executable path, so it breaks on move; for signed apps it binds to the signature. Another reason to sign.

For a "red dot while streaming" indicator: swap `setImage()` on all platforms; add `setTitle()` on macOS.

**globalShortcut**: `register()` returns a boolean and *"will silently fail"* if another app holds the accelerator — always check the return value and surface a conflict to the user. Cannot be used before `app.ready`. On macOS, media keys specifically need trusted-accessibility authorization; ordinary shortcuts don't need TCC. **On Wayland, shortcuts go through the XDG GlobalShortcuts portal** — needs a valid `desktopName` in `package.json`, users get a consent dialog on GNOME, and Electron requires `--enable-features=GlobalShortcutsPortal` (PR #45171). There's a live breakage with xdg-desktop-portal ≥1.20 / GNOME 50 where the host `Registry.Register` handshake is never called and `register()` fails (#51875).

**Clipboard — breaking change in Electron 44**: the `clipboard` module is **no longer exposed to renderer processes**, and its four read/write methods now return Promises, aligning with the W3C Clipboard API. Renderers must use `navigator.clipboard`, or expose helpers via `contextBridge` from a preload. If we copy a share link to the clipboard from the renderer, this will bite on a 42→44 upgrade.

**Notifications**: Windows needs a Start Menu shortcut carrying an AppUserModelID + ToastActivatorCLSID — Squirrel/electron-winstaller sets this up automatically, but in dev we must call `app.setAppUserModelId(process.execPath)`. macOS *"application will need to be code-signed in order for notification events to emit correctly"* and truncates at 256 bytes. Linux uses libnotify. The 43–44 cycle added `Notification.remove()`/`removeAll()`/`removeGroup()`/`getHistory()` on macOS and `id`/`groupId`/`groupTitle` on Windows+macOS — useful for clearing a "you're sharing" notification when the stream ends.

**Launch at login**: `app.setLoginItemSettings()` is **macOS + Windows only — Linux is unsupported** (hand-write `~/.config/autostart/*.desktop`). macOS now exposes `SMAppService` types (`mainAppService`, `agentService`, `daemonService`, `loginItemService`) and *"your app should be code signed and notarized for login item settings to work reliably."* Windows gets `path`, `args`, `enabled`, `name`.

**Single instance**: `app.requestSingleInstanceLock([additionalData])` returns a boolean; the primary gets `second-instance` with `(event, argv, workingDirectory, additionalData)`. `argv` is *not* byte-identical to what the second instance received. macOS/Linux cap the message at 32 MB.

**`powerSaveBlocker`**: use `'prevent-display-sleep'` during an active share (it outranks `'prevent-app-suspension'`; only the highest-precedence active blocker takes effect). Docs list no platform caveats.

---

## 5. Toolchain

These are three different categories and the "vs" framing is misleading:

- **electron-vite 5.0.0** is a *bundler/dev-server*. HMR for renderers, hot reload for main and preload, Electron-aware asset handling, V8 bytecode compilation for source protection. It does **not** package or distribute.
- **Electron Forge 7.11.2** is packaging + distribution, and it's what the official Electron docs point you at. Its philosophy is to wrap first-party tools (`@electron/packager`, `@electron/osx-sign`, `@electron/notarize`, `@electron/universal`, Squirrel) rather than reimplement them, which means it *"receives new capabilities as soon as they are supported in Electron."* It ships an official Vite plugin and templates (`@electron-forge/plugin-vite` and `template-vite`/`template-vite-typescript`, all 7.11.2), so Forge+Vite is first-class.
- **electron-builder 26.15.3** is packaging + distribution with its own in-house implementations, more configuration surface, more target formats, and the `electron-updater` (6.8.9) auto-update stack many teams prefer.

**Recommendation:** Electron Forge 7.11.2 with `plugin-vite`. We get Vite's dev loop and the officially-blessed distribution path, and Forge's thin-wrapper design means less lag when Electron ships new signing/notarization behavior — which matters for a screen-capture app that lives close to OS permission APIs. Reach for electron-builder only if we hit a packaging target Forge lacks.

**Auto-update.** `update.electronjs.org` is free and hosted, but the requirements are strict and verbatim: *"App runs on macOS or Windows"*, *"App has a public GitHub repository"*, *"Builds are published to GitHub Releases"*, *"Builds are code-signed (macOS only)"*. **No Linux, no private repos.** `update-electron-app` is the drop-in client (checks at launch then every 10 min). If the repo is private or we need Linux, use `electron-updater`, or self-host via Hazel/Nuts/electron-release-server/Nucleus.

**Signing, by OS:**

- **macOS** — Apple Developer Program membership, Developer ID Application cert, hardened runtime, then notarization via `@electron/notarize` 3.1.1. Unsigned apps hit Gatekeeper, which on recent macOS reports the misleading *"The app is damaged."* Signing isn't optional for us: `safeStorage`, `app.setLoginItemSettings()`, cookie encryption, notification events, and `autoUpdater` **all fail without it**.
- **Windows** — Since **June 2023**, code-signing keys must live on FIPS 140 Level 2 / Common Criteria EAL 4+ hardware; a plain file-based cert makes Windows treat the app as *"completely unsigned."* The 2026 answer is **Azure Artifact Signing** — Microsoft renamed Trusted Signing to Artifact Signing on Jan 28, 2026, and made it GA in the US, Canada and Europe that month. Cloud-based (no token, works from any OS/CI), certs renewed daily with 24-hour validity, generally cheapest. Note the **geographic restriction**. Alternatives: DigiCert KeyLocker, Azure Key Vault + EV cert (note: AKV code-signing certs drop to 1-year max validity from Feb 2026). All Electron tooling now routes through `@electron/windows-sign` / `windowsSign` config. Expect SmartScreen reputation to take time regardless.
- **Linux** — no signing requirement. AppImage/deb/rpm/Flatpak/Snap as usual.

---

## 6. Open-source apps worth studying

| App | Stack | Capture backend | License | Status |
|---|---|---|---|---|
| **`@jitsi/electron-sdk`** | Electron (JS) | `desktopCapturer` + `setDisplayMediaRequestHandler` | Apache-2.0 | **Active** (v10.0.4) |
| jitsi-meet-electron | Electron (TS) | via the SDK above | Apache-2.0 | Active |
| **Kap** | **Electron** (TS) | — | MIT | **Stale — last push Nov 12, 2024** (19.3k★) |
| **Cap** | **Tauri/Rust** | `scap-screencapturekit`, `scap-direct3d` | source-available | Very active (21.3k★) |
| OBS Studio | C/C++ | WGC + DXGI / SCK / PipeWire | GPL-2.0 | Very active (75k★) |
| Screenity | Chrome extension (JS) | — not Electron | GPL-3.0 | Active |
| ScreenToGif | C# / .NET, Windows-only | — | MS-PL | Active |
| Peek | Vala, Linux-only | — | GPL-3.0 | **Archived Sep 2025** |

**`@jitsi/electron-sdk` is our reference implementation.** Its README describes exactly our feature set: *"Custom screen/window picker plus an always-on-top 'X is sharing your screen' tracker window."* Apache-2.0, actively maintained, structured as main/preload/renderer entry points with a validated `contextBridge` bridge. Specific things to steal:

- The request-ID map for concurrent `getDisplayMedia` calls.
- The `isWayland()` branch that bypasses the custom picker entirely.
- `_acceptsEventSender()` — IPC events are only accepted from the meeting window's webContents or the tracker window's, everything else rejected. Good hygiene for a capture app.
- Thumbnails serialized to `thumbnail.dataUrl` at the bridge boundary rather than shipping `NativeImage` across IPC.
- The always-on-top tracker window (530×40) as a separate `BrowserWindow`.
- `windowsEnableScreenProtection` helper for excluding our own windows from capture.

**Kap is a cautionary tale, not a model** — the best-known Electron screen recorder, dormant ~21 months, with commentary attributing this to the difficulty of keeping Electron current with macOS capture changes. **Cap is Rust/Tauri, not Electron**, and its crate list (`scap-screencapturekit`, `scap-direct3d`, `enc-avfoundation`, `enc-mediafoundation`) shows a fully native per-OS capture and encode pipeline with **no Linux capture crate at all** — macOS+Windows only. That's the tradeoff we're buying out of by choosing Electron: we get Chromium's capture pipeline and Linux for free, and give up the frame-level control Cap has.

LiveKit's screen share docs are thin — `setScreenShareEnabled(true)` and tab-audio, with **no Electron-specific guidance** and no documented resolution presets on the page reached. We'll be writing the Electron integration ourselves either way.

---

## Consolidated gotchas

1. **Wayland kills our custom picker.** Branch on `XDG_SESSION_TYPE === 'wayland'`, not on `process.platform === 'linux'`.
2. **`getDisplayMedia` throws `TypeError` on `min`/`exact` constraints.** Resolution/fps are hints only; enforce real limits at the encoder/sender.
3. **Chromium auto-throttles resolution behind our back** and has no signal for compositor overload.
4. **macOS TCC won't register the app** until we actually call `getSources()`; status is cached and often needs a restart after granting.
5. **Missing `NSAudioCaptureUsageDescription` produces silent audio, not an error** (Electron 39+).
6. **Electron 44 removes `clipboard` from renderers** and makes it Promise-based — an upgrade trap.
7. **Electron 44 requires macOS 13+** and drops 32-bit Windows/ARMv7 builds.
8. **Tray on Linux has no right-click, no `popUpContextMenu`, no `getBounds`**, and left-vs-double-click varies by DE.
9. **Tray `setContextMenu()` suppresses mouse events on macOS** — use `popUpContextMenu()` for both behaviors.
10. **`globalShortcut.register()` fails silently** on conflict; on Wayland it needs a portal, a `desktopName`, a feature flag, and is currently broken on GNOME 50.
11. **`setLoginItemSettings` doesn't exist on Linux.**
12. **Unsigned macOS builds break login items, safeStorage, notifications, and autoUpdater** — signing is a functional dependency, not just distribution polish.
13. **`update.electronjs.org` needs a public repo and doesn't do Linux.**
14. **Windows tray GUID persistence breaks for unsigned apps** when the exe moves.
15. **`useSystemPicker` is macOS-15-only, experimental, and has a known hang bug.** Jitsi ships it off.

**Two things not verified** — test empirically rather than assume: whether Chromium currently defaults to WGC or DXGI for window/screen capture on Windows, and which Chromium milestone made ScreenCaptureKit the macOS default. Public documentation on both is thin.

## Sources

- https://www.electronjs.org/docs/latest/api/desktop-capturer
- https://github.com/electron/electron/blob/main/docs/api/desktop-capturer.md
- https://github.com/electron/electron/blob/main/lib/browser/api/desktop-capturer.ts
- https://www.electronjs.org/docs/latest/api/session
- https://www.electronjs.org/docs/latest/breaking-changes
- https://www.electronjs.org/docs/latest/tutorial/electron-timelines
- https://releases.electronjs.org/releases/stable
- https://releases.electronjs.org/release/v44.0.0
- https://releases.electronjs.org/release/v43.0.0
- https://releases.electronjs.org/release/v17.0.0
- PRs: https://github.com/electron/electron/pull/30702 · /43581 · /39111 · /45171 · /37315
- Issues: https://github.com/electron/electron/issues/45306 · /47980 · /45517 · /36722 · /35025 · /51875
- https://www.electronjs.org/docs/latest/api/tray
- https://www.electronjs.org/docs/latest/api/global-shortcut
- https://www.electronjs.org/docs/latest/api/app
- https://www.electronjs.org/docs/latest/tutorial/notifications
- https://www.electronjs.org/docs/latest/api/power-save-blocker
- https://www.electronjs.org/docs/latest/tutorial/code-signing
- https://www.electronjs.org/docs/latest/tutorial/updates
- https://www.electronforge.io/core-concepts/why-electron-forge
- https://electron-vite.org/
- https://www.electron.build/docs/features/code-signing/code-signing-win/
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/contentHint
- https://www.chromium.org/developers/design-documents/auto-throttled-screen-capture-and-mirroring/
- https://azure.microsoft.com/en-us/products/artifact-signing
- https://learn.microsoft.com/en-us/azure/artifact-signing/faq
- https://www.devclass.com/security/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/4079554
- https://github.com/jitsi/jitsi-meet-electron-sdk
- https://github.com/wulkano/Kap
- https://github.com/CapSoftware/Cap
- https://docs.livekit.io/transport/media/screenshare/
- https://issues.webrtc.org/issues/42225786
- https://learn.microsoft.com/en-us/answers/questions/591417/about-window-graphics-capture-yellow-border
