# Desktop/System Audio Capture in Electron — 2026 State of the Art

> Research report produced 2026-08-26. Scope: system/per-app audio capture for the
> Electron publisher and the browser publisher, echo avoidance, high-quality Opus over
> WebRTC, in-app processing, and reference architectures. Evidence base: primary
> sources (Chromium/Electron source code, MDN browser-compat-data, W3C specs) read
> directly. Unverified items are marked in §10.

**Bottom line:** system audio works out of the box in Electron on all three OSes today with zero native code, but each OS has one non-obvious gate (macOS: an Info.plist key whose absence produces a *silent dead stream*; Linux: a Chrome-picker feature flag that Electron probably bypasses). The real work is not capture — it's (a) turning **off** Chromium's audio processing, which `getDisplayMedia` silently turns **on** for desktop audio, and (b) SDP-munging `stereo=1`, which still has no API in 2026.

---

## 1. Matrix A — Electron, out of the box

Current Electron stable is **44.0.0**; 43.x and 42.x are the other supported lines.

| | Windows | macOS | Linux |
|---|---|---|---|
| **`audio: 'loopback'` works?** | ✅ Yes, long-standing | ✅ Yes, **macOS 13+**, but see the Info.plist gate | ⚠️ Very likely yes, **needs an empirical test** |
| **Since** | Electron 20 (`setDisplayMediaRequestHandler`, PR #30702) | Electron 39 on macOS 14.2+ (maintainer-confirmed) | Backend has existed for a while; ungated in the audio service |
| **Underlying API** | WASAPI loopback | **CoreAudio Tap** on 14.2+; ScreenCaptureKit on 13.0–14.1 | PulseAudio `@DEFAULT_SINK@` monitor via `PulseLoopbackManager` |
| **Extra setup** | None | **`NSAudioCaptureUsageDescription` in Info.plist** | None expected |
| **Permission prompt** | None | Yes — TCC "System Audio Recording", on first capture | None (PipeWire/Pulse have no audio permission model) |
| **`loopbackWithMute`** | ✅ | ✅ | ⚠️ Only one at a time (see gotchas) |
| **`restrictOwnAudio`** | ✅ Electron **43.4.0 / 44.0.0** | ✅ Same | ❌ Silently falls back to plain loopback |
| **Per-app audio** | Hypothesis: yes via undocumented escape hatch (Win 11+) | Hypothesis: yes, same (14.2+) | ❌ Native/PipeWire work required |

The single most useful correction to the common mental model: **Electron's `docs/api/session.md` is wrong.** Line 1135 still says loopback is *"currently only supported on Windows."* Electron maintainer MarshallOfSound closed [electron#47490](https://github.com/electron/electron/issues/47490) on 2026-08-11 saying "System audio loopback works on macOS 14.2+ as of [Electron] 39 (#49717), it uses CoreAudio taps rather than SCK but that's an implementation detail." The `desktop-capturer.md` page in the same repo documents the macOS behavior correctly. Don't let the stale line send you down a native-module path you don't need.

Why the docs can be stale without anything breaking: **Electron's C++ does no platform gating at all.** In `shell/browser/electron_browser_context.cc`, the `audio` string is passed straight through as a media-stream device id. All platform gating lives in Chromium's audio service:

```cpp
} else if (result_dict.Get("audio", &id)) {
  if (request.restrict_own_audio &&
      id == media::AudioDeviceDescription::kLoopbackInputDeviceId) {
#if BUILDFLAG(IS_MAC) || BUILDFLAG(IS_WIN) || BUILDFLAG(IS_CHROMEOS)
    id = media::AudioDeviceDescription::kLoopbackWithoutChromeId;
#else
    id = media::AudioDeviceDescription::kLoopbackInputDeviceId;   // Linux: no-op
#endif
  }
  blink::MediaStreamDevice audio_device(request.audio_type, id, "System audio");
```

That `#else` branch is worth internalizing: on Linux, `restrictOwnAudio: true` is accepted and then silently does nothing.

### The macOS gate, in detail

As of **Electron v39.0.0-beta.4**, Chromium made Apple's CoreAudio Tap API the default for desktop audio capture, and **there is no fallback** to the old Screen & System Audio Recording permission path if tap creation fails. From `docs/api/desktop-capturer.md`, emphasis theirs:

> **Warning:** Failure of `desktopCapturer` to start an audio stream due to `NSAudioCaptureUsageDescription` permission not present will still create a dead audio stream however no warnings or errors are displayed.

So the failure mode is a track that exists, reports live, and carries pure silence. Three practical consequences:

1. Add `NSAudioCaptureUsageDescription` to the packaged app's Info.plist. Electron PR #49717 (merged 2026-02-10, backported to 39/40/41) added it to Electron's own default plist, but electron-builder/forge configs that supply their own `extendInfo` need it explicitly.
2. **In development, the *parent* process's Info.plist is what counts.** If you launch Electron from a terminal or an IDE, that terminal or IDE must carry the key. This is why "it works packaged but not in dev" reports exist.
3. Escape hatch back to the old permission system: `app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare')`. A support-desk fallback, not a default.

Version selection logic verified in `media/base/media_switches.cc`:

- `IsMacCatapSystemLoopbackCaptureSupported()` → `MacOSVersion() >= 14'02'00`
- `IsMacSckSystemLoopbackCaptureSupported()` → `MacOSVersion() < 15'00'00` or an override feature
- `BASE_FEATURE(kMacCatapLoopbackAudioForScreenShare, base::FEATURE_ENABLED_BY_DEFAULT)`

So: macOS 13.0–14.1 uses ScreenCaptureKit, 14.2+ uses CoreAudio Tap, and 15+ is Catap-only. macOS ≤ 12.7.6 is hopeless without a virtual device like BlackHole. *(Medium confidence on the exact 13.x-vs-14.2 handoff.)*

### The Linux situation — a genuinely useful finding

Chromium **does** implement Linux system loopback. `media/audio/pulse/audio_manager_pulse.cc`:

```cpp
if (AudioDeviceDescription::IsLoopbackDevice(device_id)) {
  if (!loopback_manager_) { loopback_manager_ = PulseLoopbackManager::Create(...); }
  return loopback_manager_->MakeLoopbackStream(params, ...);
}
```

`PulseLoopbackManager` taps the monitor source of `@DEFAULT_SINK@` and subscribes to server events so it follows the user's default sink if they switch output devices mid-call.

The catch, and the reason everyone believes Linux doesn't work: `kPulseaudioLoopbackForScreenShare` is **`FEATURE_DISABLED_BY_DEFAULT`**. But tracing every consumer of that flag, it appears in exactly four places: `media_switches.h`, `media_switches.cc`, `chrome/browser/media/webrtc/desktop_media_picker_controller.cc`, and one unit test. It gates **Chrome's picker UI** — whether the "share audio" checkbox is drawn — and **not the audio backend**. `pulse_loopback_manager.cc` contains no `base::FeatureList` check whatsoever.

Electron with `setDisplayMediaRequestHandler` bypasses Chrome's picker entirely. **So `audio: 'loopback'` on Linux should work in Electron with no flag at all.** High-confidence-from-source but wants a twenty-minute empirical verification (some projects in the wild, e.g. moeru-ai/airi, set the flag anyway — cargo-culting or a gate not found). Setting the flag anyway is harmless insurance.

Also note it taps the **default sink's monitor**, so on Linux you get "everything the machine is playing" with no per-app selectivity and no way to exclude yourself.

---

## 2. Matrix B — Plain browsers (for the degraded browser publisher)

From MDN's browser-compat-data cross-checked against the Chromium source that implements the decision.

| Browser | Windows | macOS | Linux | Notes |
|---|---|---|---|---|
| **Chrome / Edge** | ✅ **Full system audio** when sharing a whole screen; tab audio when sharing a tab | ✅ **System audio on 14.2+** (Catap, on by default); tab audio otherwise | ⚠️ **Tab audio only by default** — system audio needs `--enable-features=PulseaudioLoopbackForScreenShare` | Audio since Chrome 74 |
| **Firefox** | ❌ **No audio at all** from `getDisplayMedia` | ❌ | ❌ | `getDisplayMedia` since 66, audio never |
| **Safari** | — | ❌ **No audio at all** | — | `getDisplayMedia` since 13, audio never |
| **Chrome Android / Safari iOS** | ❌ | ❌ | ❌ | Not available |

The governing code is `IsSystemAudioCaptureSupported()` in `desktop_media_picker_controller.cc`: Windows and everything-else return `true`; macOS returns `IsMacCatapSystemLoopbackCaptureSupported() && kMacCatapLoopbackAudioForScreenShare`; Linux returns `base::FeatureList::IsEnabled(kPulseaudioLoopbackForScreenShare)`, which is off.

**MDN's own note here is stale**: it says on macOS only tab audio can be captured. No longer true — Chrome ships Catap loopback enabled by default on macOS 14.2+.

**Spec surface** (`DisplayMediaStreamOptions`), with Chrome versions:

- `systemAudio: 'include' | 'exclude'` — Chrome 105, defaults to `include`
- `windowAudio: 'system' | 'window' | 'exclude'` — Chrome/Edge **141**, defaults to `system`; **Chrome only implements `exclude` and `system`, not `window`**. Per-window audio is *not* reachable from a browser today.
- `monitorTypeSurfaces` — Chrome 119; `preferCurrentTab` — 94; `selfBrowserSurface` — 112; `surfaceSwitching` — 107
- All of the above: Firefox `false`, Safari `false`.

**Practical spec for a browser-based publisher:** Chrome/Edge only, and even then treat system audio as best-effort. Detect with `stream.getAudioTracks().length` after the call and degrade the UI honestly ("Chrome on Linux can't share system audio — share a tab instead, or use the desktop app"). Firefox and Safari publishers should be offered mic-only and told so up front.

---

## 3. Per-application audio capture

### The headline: Chromium already implements this, cross-platform

Chromium has `media/audio/application_loopback_device_helper.h` (Copyright 2025) defining a **string device-id format** for per-app capture, and both platform features are on by default:

```cpp
BASE_FEATURE(kApplicationAudioCaptureWin, base::FEATURE_ENABLED_BY_DEFAULT);
BASE_FEATURE(kApplicationAudioCaptureMac, base::FEATURE_ENABLED_BY_DEFAULT);
```

The ids, confirmed in `media/audio/audio_device_description.h`:

- Windows: `applicationLoopback:<PID>`
- macOS: `applicationLoopback:<bundle_id>` or `applicationLoopback:<bundle_id>:<PID>` — bundle-id-only captures *any* process matching that bundle (catches multi-process apps)
- Plus `restrictOwnAudioBrowserLoopback:<pid>`

Gating: `IsWindowsProcessLoopbackCaptureSupported()` is literally `GetVersion() >= Version::WIN11` (more conservative than Microsoft's documented Win10 build 20348, and much more than OBS's empirical 19041). macOS is 14.2+. **Linux has no application-loopback support in Chromium at all.**

### The Electron escape hatch — highest-leverage thing to spike

`electron_browser_context.cc` has an explicitly-labelled undocumented path:

```cpp
// NB. this is not permitted by the documentation, but is left here as an
// "escape hatch" for providing an arbitrary name/id if needed in the future.
if (result_dict.Get("audio", &audio_dict) && audio_dict.Get("id", &id) && audio_dict.Get("name", &name)) {
  blink::MediaStreamDevice audio_device(request.audio_type, id, name);
```

Untested-but-source-grounded hypothesis: this gets per-app audio on Windows 11 and macOS 14.2+ with **no native module at all**:

```js
callback({ video: source, audio: { id: `applicationLoopback:${pid}`, name: 'App audio' } })
// macOS: `applicationLoopback:com.spotify.client` or `...:1234`
```

No rejection path for these ids was found in `media_stream_manager.cc` — it only *detects* them via `IsApplicationLoopbackAudioDevice`. **Unverified; must be tested before planning around it.** Roughly a one-hour spike with a very large payoff. Watch for the silent-dead-stream failure mode rather than an exception. Add the macOS Info.plist key before testing there or you'll misattribute the failure.

### If the escape hatch fails: native module territory

| | Windows | macOS | Linux |
|---|---|---|---|
| API | `ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK)` + `AUDIOCLIENT_ACTIVATION_PARAMS` | `AudioHardwareCreateProcessTap` + `CATapDescription` + aggregate device | PipeWire graph link manipulation |
| Include **and** exclude? | ✅ `INCLUDE_/EXCLUDE_TARGET_PROCESS_TREE` | ✅ `initStereoMixdownOfProcesses:` / `initStereoGlobalTapButExcludeProcesses:` | ✅ by link topology |
| Min OS (practical) | Win10 2004 / 19041 (OBS ships this) | 14.2 | any 2026 distro |
| Maintained Node wrapper | ⚠️ Barely — `loopback-capture` (11★, MIT, pushed 2026-08-15) | ❌ **None exists** | ⚠️ `node-pipewire` (18★), graph-only, no PCM path |

There is genuinely **no maintained Node wrapper for CoreAudio process taps**. The ~30 repos using `AudioHardwareCreateProcessTap` are overwhelmingly Rust/Tauri or Swift. The canonical reference is [insidegui/AudioCap](https://github.com/insidegui/AudioCap) (510★, BSD-2), a Swift sample app you'd port rather than consume. Note `@0biwank/getsystemaudio` — which the unmerged Electron PR #51154 cites — is a **red herring**: it's a system audio *level* meter, not a PCM capture library.

Linux per-app is a separate project regardless. Nothing in Chromium, and `xdg-desktop-portal`'s ScreenCast interface (v6) has **no audio key at all** — that missing portal API is exactly what has kept OBS's own Linux audio PR ([#6207](https://github.com/obsproject/obs-studio/pull/6207)) in draft since March 2022. Working community answers: [dimtpap/obs-pipewire-audio-capture](https://github.com/dimtpap/obs-pipewire-audio-capture) (792★) and [Vencord/venmic](https://github.com/Vencord/venmic) (MPL-2.0), the latter being what Vesktop uses to give Discord app-audio sharing on Linux by disguising app audio as a virtual microphone.

**How the reference apps do it:** OBS uses `wasapi_process_output_capture` on Windows (include-mode only), ScreenCaptureKit `SCContentFilter includingApplications:` on macOS 13+, and **nothing on Linux**. Discord's mechanism lives in the closed-source `discord_voice.node`; the "kernel-mode audio hook driver" story is unsourced folklore.

---

## 4. Echo / feedback avoidance

| Mechanism | What it does | Availability |
|---|---|---|
| **`restrictOwnAudio: true`** | Removes **your own app's** audio from the capture. Maps to device id `loopbackWithoutChrome`. | **Electron 43.4.0 (2026-08-11) and 44.0.0**. Win/macOS/ChromeOS. **No-op on Linux.** |
| **`suppressLocalAudioPlayback: true`** | Stops relaying the captured audio to local speakers while still capturing it. Maps to `loopbackWithMute`. | Same Electron versions; same platforms |
| **`audio: 'loopbackWithMute'`** | The same thing, chosen explicitly by the main process | Long-standing |
| **`enableLocalEcho`** | **Only applies when `audio` is a `WebFrameMain`** (tab capture). Default `false`. Not usable for system audio. | Electron 22 (PR #37315) |
| **Per-app exclude** | `EXCLUDE_TARGET_PROCESS_TREE` / `initStereoGlobalTapButExcludeProcesses:` | Native module, or possibly the escape hatch |

The W3C distinction, from `mediacapture-screen-share`:

> **restrictOwnAudio**: "the user agent MUST attempt to remove any audio from the audio being captured that was produced by the document that performed getDisplayMedia()."
> **suppressLocalAudioPlayback**: "the user agent SHOULD stop relaying audio to the local speakers, but that audio MUST still be captured."

So `restrictOwnAudio` is the anti-feedback one (don't capture myself), `suppressLocalAudioPlayback` is the "mute the sharer's speakers" one.

**For the Discord-while-gaming scenario specifically:** none of these solve it. `restrictOwnAudio` excludes *your* app, not Discord. Excluding a *third-party* app requires either the per-app exclude mode (native, or the escape hatch) or capturing only the game (per-app include). The honest v1 answer: capture system audio with `restrictOwnAudio: true`, and tell the user to route voice chat to a different output device or accept that it's in the stream. That's what most products actually ship.

Practical wiring:

```js
// renderer
navigator.mediaDevices.getDisplayMedia({
  video: {...},
  audio: { restrictOwnAudio: true, suppressLocalAudioPlayback: false,
           echoCancellation: false, noiseSuppression: false, autoGainControl: false }
})
// main
callback({ video: source, audio: 'loopback' })   // Electron upgrades to loopbackWithoutChrome
```

Note the layering: the *renderer* asks for `restrictOwnAudio`, and the *main process* still returns the plain `'loopback'` string — Electron rewrites it. Returning `'loopbackWithMute'` from main would override.

---

## 5. High-quality Opus over WebRTC

### The two facts that matter most

**(a) `setParameters()` maxBitrate genuinely works for audio in Chromium.** This contradicts most blog posts (~2019 vintage). In `webrtc_voice_engine.cc`, `SetRtpSendParameters` → `ComputeSendBitrate` takes `MinPositive(sdp_b_line, rtp_max_bitrate_bps)` and reconfigures the send stream. The clamp is against `AudioEncoderOpusConfig::kMaxBitrateBps = 510'000`, *not* against the negotiated `maxaveragebitrate` — which only sets the encoder's *starting* bitrate. So `sender.setParameters({...p, encodings:[{...p.encodings[0], maxBitrate: 256_000}]})` raises the real Opus target with no munging. Corroborated by LiveKit's client SDK, which sets `maxBitrate` for audio and only SDP-munges `maxaveragebitrate` **for Firefox** (which treats it as the actual bitrate rather than a ceiling).

**(b) Stereo still requires SDP munging. There is no API.** The complete `RTCRtpEncodingParameters` extension in the current webrtc-extensions draft is `scaleResolutionDownTo`, `ptime`, `adaptivePtime`. `opusStereo`/`opusDtx`/`opusMaxAverageBitrate` are vapor — not shipped, not draft. `setCodecPreferences` and `encodings[].codec` (Chrome 119) pick *which* codec but cannot set fmtp parameters. You must ensure `stereo=1` reaches the *encoder's* remote description; even LiveKit, which controls both ends, does it by string surgery on both client and server.

### The APM trap — most important gotcha in this report

**Chromium applies its full voice-processing pipeline to `getDisplayMedia` audio by default.** In `media_stream_constraints_util_audio.cc`, capture is classified into `kGumMicrophone` / `kExtensionScreenShare` / `kOther`, and `getDisplayMedia` falls into `kOther`. The default-processing decision is `return api_ != AudioCaptureApi::kExtensionScreenShare` — **true** for `kOther`. So: AGC on, noise suppression on, echo cancellation at browser discretion, forced 48 kHz, and `GetApmSupportedChannels()` returning `{1, deviceChannels}` **with mono listed first**.

The bitter irony: Electron's *legacy* path — `getUserMedia({audio:{mandatory:{chromeMediaSource:'desktop'}}})` — lands in `kExtensionScreenShare` and gets **APM off by default**. The old deprecated API was accidentally the high-fidelity one. Migrating to `setDisplayMediaRequestHandler` without explicit constraints quietly acquires noise suppression and AGC.

With APM off (`kUnprocessed`), the container is native channel count, native rate, no negotiation. **The reliable way to get stereo is to turn APM off, not to constrain `channelCount`.**

### Concrete recommended settings

```js
// capture
audio: {
  echoCancellation: false, noiseSuppression: false, autoGainControl: false,
  channelCount: 2, sampleRate: 48000,
  restrictOwnAudio: true,
}
// then verify with track.getSettings() — do not assume
```

| Param | Value | Why |
|---|---|---|
| `maxBitrate` via `setParameters` | **160–256 kbps** stereo | ~128k near-transparent for most music; 256k gives headroom |
| Hard cap | 510 000 bps | `kMaxBitrateBps`; RFC 7587 range is 6000–510000 |
| `stereo=1` + `sprop-stereo=1` | **Required** | Without it Opus downmixes to mono and defaults to 32 kbps |
| `usedtx` | **0 (off)** | DTX pumps audibly on music tails and reverb; LiveKit auto-disables it for stereo |
| `useinbandfec` | Off / don't bother | LBRR only operates in SILK/hybrid; music above ~128 kbps runs pure CELT where it's unavailable |
| `cbr` | Off (VBR) | CBR starves transients |
| `ptime` | 20 ms (default) | At 192 kbps, RTP overhead is ~3% |
| RED | Consider at 128–160k instead of 256k+RED | Shipped in Chromium but **off unless negotiated**; enable via `setCodecPreferences` with `audio/red` first. Unlike in-band FEC, RED works in CELT mode |

**LiveKit specifics** (from `client-sdk-js` source): the audio presets are just `maxBitrate` values — `music: 48_000` (the **default**, mono), `musicStereo: 64_000`, `musicHighQuality: 96_000`, `musicHighQualityStereo: 128_000`. Nothing stops a custom `{ maxBitrate: 256_000, priority: 'high' }`. Two behaviors: **stereo auto-disables both DTX and RED** unless set explicitly, and `getSettings().channelCount` is unreliable in Chromium, so LiveKit's stereo auto-detection frequently fails — **always pass `forceStereo: true` explicitly**. The server writes `;stereo=1;maxaveragebitrate=510000` into the answer, so on LiveKit your `maxBitrate` is the real limiter. The SFU forwards Opus without transcoding; `adaptiveStream` and `dynacast` are video-only.

---

## 6. In-app processing

Web Audio mixing (`MediaStreamAudioSourceNode → GainNode → MediaStreamAudioDestinationNode`) is reliable in Chromium 2026. `MediaStreamAudioDestinationNode` defaults to `channelCount: 2`, `channelCountMode: 'explicit'` — it does **not** downmix. Mono creeps in from three other places: `GainNode` defaults to `channelCountMode: 'max'` and inherits its input's channel count; the mic is mono whenever APM is on; and Opus is mono unless the SDP says otherwise.

Construct the context explicitly as `new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })` — 48 kHz matches Opus, WASAPI/CoreAudio/PipeWire shared-mode defaults, and RNNoise's requirement. Budget one render quantum (128 frames / 2.67 ms) per graph pass plus `baseLatency`.

**Electron-specific:**
- Set **`backgroundThrottling: false`** at window construction. [electron#50250](https://github.com/electron/electron/issues/50250) shows that toggling it *dynamically* while minimized desyncs visibility state — don't do it at runtime.
- **Do not enable `nodeIntegrationInWorker` with AudioWorklet.** All 22 electron issues matching "AudioWorklet" are about that combination ([#22503](https://github.com/electron/electron/issues/22503), [#37038](https://github.com/electron/electron/issues/37038), [#25248](https://github.com/electron/electron/issues/25248)). [#34845](https://github.com/electron/electron/issues/34845) — "AudioWorklet received data is all zeros when packaged" — is worth reading before shipping.
- Serve the renderer from a privileged custom scheme (`standard: true, secure: true, supportFetchAPI: true, corsEnabled: true`, registered before `app.ready`) or `http://localhost`, not `file://`, so `audioWorklet.addModule()` can fetch its module script. Bulletproof fallback: Blob URL.

**Noise suppression (mic path only — never on the desktop track):** the clear winner is **`@sapphi-red/web-noise-suppressor`** (MIT, v0.4.0, 2026-08-09). Wraps the maintained `@shiguredo/rnnoise-wasm`, adds AudioWorklet plumbing, plus a GTCRN DNN denoiser that outperforms RNNoise. Avoid `rnnoise-wasm` on npm — security holding package. `@jitsi/rnnoise-wasm` is ~18 months stale.

Two RNNoise details that cause most hand-rolled integrations to silently no-op: it requires **exactly 480 samples at 48 kHz mono**, and it expects float samples in **int16 magnitude range, not [-1, 1]** — feed it normalized floats and it sees near-silence and does nothing. 480 doesn't divide the 128-frame quantum, so wrappers ring-buffer and add ~13.3 ms. RNNoise upstream is BSD-3-Clause. Krisp remains proprietary.

**`voiceIsolation` is not usable on desktop.** Per [chromestatus 5106413661847552](https://chromestatus.com/feature/5106413661847552), it "only takes effect on platforms where there is low-level support... currently limited to a selected number of ChromeOS devices." Feature-detect via `getCapabilities().voiceIsolation`; don't build on it.

---

## 7. Reference architectures

**OBS** runs exactly one global `audio_output` per process at hardcoded `AUDIO_FORMAT_FLOAT_PLANAR`, mixed by a **fixed-rate clock thread** (1024 frames ≈ 21.33 ms per tick at 48 kHz) rather than device-driven. Every source is resampled to one global rate via libswresample. Two design ideas worth stealing: per-source volume is applied **sample-accurately** as timestamped `audio_action`s building a per-frame ramp (why OBS never clicks on a fader move); and it renders a **deliberately delayed window** with monotonically-growing buffering (capped ~960 ms) so late sources still land in the right tick. Per-OS plugins: `win-wasapi` (device loopback + process loopback, gated to build 19041), `mac-capture` (`sck_audio_capture`, macOS 13.0+), `linux-pulseaudio` (monitor sources — **no PipeWire audio path in OBS**; it goes through pipewire-pulse).

**Open-source apps worth reading**, in priority order:

1. **[moeru-ai/airi](https://github.com/moeru-ai/airi)** — MIT, active. The closest match: cross-platform system audio in **pure Electron**, no native addon. Read `packages/electron-screen-capture/src/main/index.ts`, particularly `buildFeatureFlags()`. It wraps `setDisplayMediaRequestHandler` in a **mutex with timeout** because the handler is per-session and global. Steal that.
2. **[fluxerapp/fluxer](https://github.com/fluxerapp/fluxer)** — 10k★ Electron VoIP app, the most complete reference: per-OS napi addons for per-process capture, self-exclusion, exclusion lists. **AGPL-3.0 — read, don't copy.**
3. **[CapSoftware/Cap](https://github.com/CapSoftware/Cap)** → `crates/scap-cpal/src/lib.rs` (**MIT**, unlike the AGPL core). Contains a production bug fix you will hit: **WASAPI loopback delivers no packets while nothing is playing** — Cap keeps a silent render stream open to force packet flow, same trick as OBS.
4. **[Vencord/venmic](https://github.com/Vencord/venmic)** (MPL-2.0) + **Vesktop** — the definitive Linux per-app answer.

Skip: Kap (dead since 2024, mic-only), Screenity (extension, tab audio only), `screenpipe` (**proprietary despite appearances**), `electron-audio-loopback` (**no license file — no rights granted**).

---

## 8. Recommended architecture

1. **Capture** with `setDisplayMediaRequestHandler` returning `audio: 'loopback'`, and pass `restrictOwnAudio: true` plus **all three APM constraints explicitly false** from the renderer. Verify with `getSettings()` rather than assuming — this is where quality silently dies.
2. **Ship the macOS Info.plist key on day one** and add a startup self-test that captures ~200 ms of loopback and checks for non-zero RMS, so the silent-dead-stream case surfaces as a real error instead of a support ticket.
3. **Publish stereo**: `setParameters` `maxBitrate: 192_000`–`256_000`, munge `stereo=1;sprop-stereo=1` into the encoder's remote description, `usedtx=0`. On LiveKit: custom `audioPreset` plus `forceStereo: true, dtx: false` explicitly.
4. **Keep Web Audio out of the path** unless mic+system mixing is actually needed. If it is: `channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers'` on every node, graph in a window with `backgroundThrottling: false`.
5. **Mic path separately**: APM on (AEC needed), optional RNNoise/GTCRN via `@sapphi-red/web-noise-suppressor` as opt-in. Never apply noise suppression or `voiceIsolation` to the desktop track.
6. **Spike the per-app escape hatch early** — one hour; if it works, Windows 11 + macOS 14.2 per-app audio with no native module, which changes the whole roadmap.
7. **Treat Linux as tier 2** for anything beyond whole-system loopback, and the browser publisher as Chrome/Edge-only for audio.

---

## 9. Gotchas worth pinning to the wall

1. `NSAudioCaptureUsageDescription` missing → **silent dead audio stream, no error**. In dev, the *parent* process's plist is what counts.
2. `getDisplayMedia` audio gets **APM on by default**; the legacy `chromeMediaSource:'desktop'` path had it off. Migrating silently degrades audio.
3. `restrictOwnAudio` is accepted on Linux and **silently does nothing**.
4. Electron's `session.md` docs are **wrong** about macOS. Trust `desktop-capturer.md` and the source.
5. **WASAPI loopback delivers no packets during silence** — first sample arrives at first sound. Keep a silent render stream open.
6. Linux `loopbackWithMute`: only one loopback at a time (`PulseLoopbackManager` limitation, TODO upstream).
7. `getSettings().channelCount` is unreliable in Chromium — don't use it to detect stereo.
8. `setParameters()` only takes effect on a sender with a negotiated codec. Call it **after** the first answer, re-apply after every renegotiation/ICE restart.
9. Any `b=AS:` line on the audio m-section caps you below your `maxBitrate` (`MinPositive`).
10. Chrome's `windowAudio: 'window'` is **not implemented** — only `exclude` and `system`.
11. `desktopCapturer.getSources()` returns only a **single source** on Linux under PipeWire.
12. `setDisplayMediaRequestHandler` is **per-session and global** — serialize concurrent capture requests.
13. RNNoise needs int16-magnitude floats, not [-1,1]. Wrong scaling = silent no-op.
14. On Linux you tap the **default sink's monitor** — no per-app selectivity, no self-exclusion.

---

## 10. Gaps — things not verified

1. **⚠️ The per-app escape hatch is UNTESTED.** Source strongly supports it but was not run. **Highest-value spike.**
2. **⚠️ Linux `audio: 'loopback'` in Electron without the feature flag.** Traced from source; wants a 20-minute empirical confirmation.
3. **macOS 13.0–14.1 SCK-vs-Catap handoff** — final selection branch not read.
4. **Browser-compat versions for `restrictOwnAudio` / `suppressLocalAudioPlayback`** — Chromium-only in practice; version numbers unconfirmed.
5. **`MediaStreamTrack.contentHint = 'music'`** — unverified whether it wires into APM bypass or Opus application mode. Cheap to test.
6. **Whether AudioWorklet is exempt from Electron background throttling** — theory sound, uncited; `AnalyserNode` demonstrably *is* affected ([electron#12048](https://github.com/electron/electron/issues/12048)).
7. **`voiceIsolation` desktop coverage** — chromestatus entry last updated 2024-12-05.
8. **Discord's Windows/macOS mechanisms** — closed source; the "kernel driver" claim is unsourced folklore.
9. **LiveKit SFU audio-level muting / RED stripping for non-RED subscribers** — server source not read; all LiveKit claims from client SDK HEAD, not docs — version-pin accordingly.
10. `prebuild` availability for `loopback-capture` unconfirmed.

---

## Sources

**Electron:** [desktop-capturer.md](https://github.com/electron/electron/blob/main/docs/api/desktop-capturer.md) · [session.md](https://github.com/electron/electron/blob/main/docs/api/session.md) · [electron_browser_context.cc](https://github.com/electron/electron/blob/main/shell/browser/electron_browser_context.cc) · PRs [#49717](https://github.com/electron/electron/pull/49717) (macOS Catap), [#52455](https://github.com/electron/electron/pull/52455) + backports [#52533](https://github.com/electron/electron/pull/52533)/[#52534](https://github.com/electron/electron/pull/52534) (restrictOwnAudio), [#37315](https://github.com/electron/electron/pull/37315) (enableLocalEcho), [#30702](https://github.com/electron/electron/pull/30702) · issue [#47490](https://github.com/electron/electron/issues/47490) (macOS confirmation) · releases v43.4.0, v44.0.0

**Chromium:** [media_switches.cc](https://raw.githubusercontent.com/chromium/chromium/main/media/base/media_switches.cc) · [audio_device_description.cc](https://chromium.googlesource.com/chromium/src/+/main/media/audio/audio_device_description.cc) · [audio_manager_pulse.cc](https://raw.githubusercontent.com/chromium/chromium/main/media/audio/pulse/audio_manager_pulse.cc) · [pulse_loopback_manager.cc](https://raw.githubusercontent.com/chromium/chromium/main/media/audio/pulse/pulse_loopback_manager.cc) · [desktop_media_picker_controller.cc](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/media/webrtc/desktop_media_picker_controller.cc) · [desktop_capture_devices_util.cc](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/media/webrtc/desktop_capture_devices_util.cc) · [media_stream_constraints_util_audio.cc](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_audio.cc) · `media/audio/application_loopback_device_helper.h` · `media/audio/mac/catap_audio_input_stream.mm`

**WebRTC/Opus:** [webrtc_voice_engine.cc](https://raw.githubusercontent.com/webrtc-mirror/webrtc/main/media/engine/webrtc_voice_engine.cc) · [audio_encoder_opus_config.h](https://raw.githubusercontent.com/webrtc-mirror/webrtc/main/api/audio_codecs/opus/audio_encoder_opus_config.h) · [RFC 7587 §7.1](https://datatracker.ietf.org/doc/html/rfc7587#section-7.1) · [w3c.github.io/webrtc-extensions](https://w3c.github.io/webrtc-extensions/) · [chromestatus 5200982281027584](https://chromestatus.com/feature/5200982281027584)

**Specs/compat:** [W3C mediacapture-screen-share](https://w3c.github.io/mediacapture-screen-share/) · [mediacapture-extensions voiceIsolation](https://w3c.github.io/mediacapture-extensions/#voiceisolation-constraint) · [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) · mdn/browser-compat-data `api/MediaDevices.json` · [chromestatus 5106413661847552](https://chromestatus.com/feature/5106413661847552)

**Platform APIs:** [AUDIOCLIENT_ACTIVATION_PARAMS](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_activation_params) · [Apple CoreAudio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps) · [xdg-desktop-portal ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)

**Reference apps:** [moeru-ai/airi](https://github.com/moeru-ai/airi) · [fluxerapp/fluxer](https://github.com/fluxerapp/fluxer) · [CapSoftware/Cap](https://github.com/CapSoftware/Cap) · [Vencord/venmic](https://github.com/Vencord/venmic) · [insidegui/AudioCap](https://github.com/insidegui/AudioCap) · [dimtpap/obs-pipewire-audio-capture](https://github.com/dimtpap/obs-pipewire-audio-capture) · [obs-studio](https://github.com/obsproject/obs-studio) · [OBS PR #6207](https://github.com/obsproject/obs-studio/pull/6207) · [@sapphi-red/web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor) · [xiph/rnnoise](https://github.com/xiph/rnnoise)
