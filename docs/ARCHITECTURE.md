# easyscreenshare — Architecture

> Consolidated from the research in `docs/research/01`–`04` (2026-08-26) plus product
> decisions. This is the living design doc; update it when decisions change.

## What this is

Discord banned screensharing/video in Brazil (ANPD order, 2026-08-17). This project
replaces exactly that one feature, without rebuilding Discord:

**Click the tray icon → pick what to share → a link is in your clipboard. Anyone who
opens the link watches in their browser. That's it.**

- Publisher: Electron tray app (Windows first, then Linux/macOS) — plus a degraded
  browser-based publisher on the website (Chromium-only for audio).
- Viewers: any browser, no account, no install, watch-only. Voice conversation stays
  in Discord (which still works).
- Quality: Discord-parity tiers — 720p/1080p/native × 15/30/60 fps, viewer-selectable
  and bandwidth-adaptive.
- Audio: the differentiator. System audio on all three OSes, music-grade stereo Opus
  (192–256 kbps, voice-processing off), and — if the per-app spike pans out —
  "capture only the game" / "exclude Discord" with zero native code.
- License: **MIT**. Fully open source.

## Decisions log

| Decision | Choice | Why (see research doc) |
|---|---|---|
| Media server | **LiveKit, self-hosted** | Only option with quality tiers + adaptive client + embedded TURN + E2EE out of the box (01) |
| Codec | **H.264 simulcast** default; VP9 opt-in "sharp text" mode; no AV1 yet | Hardware encode everywhere, Safari-safe; VP9 best bitrate for screen content (01) |
| Publisher framework | **Electron 44 + Forge + Vite plugin** | Official path; Chromium capture pipeline + Linux for free (02) |
| Viewer/publisher web | Same LiveKit JS SDK | WHEP rejected: layer-switching not standardized; we don't need WHIP (01) |
| v0 deploy target | **outpost.flipbit03.com (Vultr EWR)** | $0, existing user+compose+Caddy+GHA pattern; accept ~200 ms extra RTT; move media to a São Paulo box later — it's one URL (infra inspection) |
| Later media host | Vultr São Paulo (~$10–20/mo) when latency annoys | $0.01/GB overage; AWS sa-east-1 is 14× the cost (01) |
| Viewers talk back? | **Watch-only** | Discord voice still works; keeps viewer page trivial. Rooms architected so subscriber-only tokens could later become publish-capable |
| Signing | **None for v0** (ad-hoc macOS is automatic). v1: SignPath (free, OSS) + winget/Scoop. macOS $99/yr only if mac users materialize | (03) — note Homebrew bans non-notarized casks from 2026-09-01 |
| License | **MIT** | SignPath requires OSI + no dual-licensing; MIT qualifies |
| Backend language | **Rust (axum)** | Mirrors the proven 2048wars stack/pipeline; official `livekit-api` crate covers tokens/rooms/webhooks; tiny binary on the 4 GB box. FE/desktop stay TS (forced by browser APIs); `ts-rs` generates shared API types |
| E2EE | Build later as off-by-default "private stream" toggle; key in URL fragment | Encoded-transform is cross-browser Baseline; ~1 day on LiveKit (01) |
| Per-app audio strategy | **Include-mode via Electron escape hatch** (window share = that app's audio only) — S1 field-CONFIRMED. Exclude-mode ("system minus Discord") REFUTED as silent dead stream; needs native process-loopback module (5.2) | S1 verdict 2026-08-26, research 04 §10 |

## Components

```
packages/
  server/     # Rust (axum): create session → mint LiveKit tokens (livekit-api
              #   crate) → short link (/s/:id), serves the built web app, LiveKit
              #   webhooks. ts-rs exports API types to the TS side. ~small forever.
              #   (Cargo workspace member; invisible to pnpm — no package.json.)
  web/        # Static SPA (TS): viewer page (video, quality picker, volume,
              #   fullscreen, viewer count) + browser publisher (Chromium-only audio).
  core/       # Shared TS publish pipeline: capture → constraints/APM-off →
              #   simulcast encodings → LiveKit publish. Browser AND Electron renderer.
  desktop/    # Electron shell around core: tray, custom picker (thumbnails via
              #   desktopCapturer), loopback audio, clipboard, notifications.
infra/        # compose file + Caddy vhost + deploy workflow (mirrors 2048wars pattern)
docs/
```

Note WebRTC signaling is LiveKit's own WebSocket, client↔LiveKit directly — the
Rust server is a session/token API, not a signaling relay.

The web app is the core product; Electron is a premium shell around the same
pipeline. This ordering de-risks: all streaming unknowns get validated in M1 where
iteration is fastest, before any OS-specific capture code exists.

### Media path

```
Publisher (Electron or Chromium browser)
  └─ WebRTC, simulcast layers (e.g. native@60 + 720p@30 + low@15, H.264)
      └─ LiveKit SFU (outpost, later São Paulo) ── forwards, never transcodes
          ├─ Viewer A: auto (adaptiveStream) or manual setVideoQuality
          ├─ Viewer B: TURN/TLS fallback (corporate networks)
          └─ ...
```

- Capture is ALWAYS native resolution; tiers are enforced at the encoder
  (`scaleResolutionDownBy` / `maxFramerate` / `maxBitrate`) because
  `getDisplayMedia` constraints are hints only (02 §3).
- `degradationPreference` set explicitly (maintain-resolution for text content);
  don't rely on `contentHint` alone — known Chrome bug (01 §2).
- Dynacast on: layers nobody watches aren't encoded.
- 60 fps is UNPROVEN end-to-end (flagged independently by 01 and 02) → spike S2.

### Audio path (the differentiator — details in 04)

- Electron: `setDisplayMediaRequestHandler` → `audio: 'loopback'`,
  renderer requests `restrictOwnAudio: true` + `echoCancellation/noiseSuppression/
  autoGainControl` ALL explicitly false (APM-on-by-default trap).
- Stereo: SDP-munge `stereo=1;sprop-stereo=1`; LiveKit `forceStereo: true, dtx:
  false`, custom preset `maxBitrate: 192_000–256_000`.
- macOS: `NSAudioCaptureUsageDescription` in Info.plist from day one; startup RMS
  self-test so the silent-dead-stream failure surfaces as an error.
- Windows: keep a silent render stream open (WASAPI delivers nothing during silence).
- Per-app capture (spike S1): `callback({video, audio: {id:
  'applicationLoopback:<pid>', name}})` via Electron's undocumented escape hatch.
  Win11 + macOS 14.2+ only; Linux is whole-system-only, tier 2.
- Mic is **OFF by default — strictly opt-in** (sharers are usually already on
  Discord voice; we're the screen half, not the voice half). No getUserMedia,
  no mic permission prompt ever, unless the user enables it in the picker.
  When on: mixed via Web Audio, APM on, opt-in RNNoise via
  `@sapphi-red/web-noise-suppressor`. Never process the desktop track.
- Sharer-side audio quality presets (audio has no simulcast — one encoding for
  all viewers): Voice (~64 kbps, DTX on) / Balanced (~128 kbps stereo, default) /
  Music (~256 kbps stereo, DTX off). Live-switchable mid-stream via
  `sender.setParameters` maxBitrate — no renegotiation, no blip. Negotiate
  stereo + the max ceiling once at publish.

### Session/link model

- `POST /api/sessions` → creates LiveKit room, returns `{shareUrl, publisherToken}`.
- Publisher token: publish-only, room-scoped. Viewer page hits
  `GET /api/sessions/:id/token` → short-lived subscribe-only JWT. No accounts.
- Link death = room close (publisher disconnect timeout or explicit stop).
- Later: link expiry, optional password, "kick all", E2EE key in URL fragment.

## Deployment (v0, on outpost)

Follows the 2048wars pattern exactly (Ansible shapes machine, app repo owns ~user):

- Ansible (my_infra): `easyscreenshare` user (docker group) + deploy key + Caddy vhosts.
- Caddy: `easyscreenshare.flipbit03.com` → API/web (localhost port); `lk.easyscreenshare.flipbit03.com` →
  LiveKit signaling :7880 (WebSocket — Caddy handles natively).
- Exposed directly (not via Caddy): UDP 7882 (muxed media), TCP 7881 (ICE/TCP
  fallback). TURN moved OFF 3478 (taken by headscale DERP) — TURN/UDP on an alt
  port; TURN/TLS on 5349 later if corporate-network viewers matter. 443 stays
  Caddy's.
- GHA: build → GHCR → scp compose → ssh `docker compose up` → health gate.
- Server headroom: 2 vCPU / 4 GB, ~3 GB RAM free — LiveKit needs a few hundred MB;
  SFU forwarding won't dent 2 vCPUs at friends-scale. NIC/egress is the ceiling
  (01 §5). Verify inbound UDP isn't filtered by a Vultr firewall group on first
  deploy.

## Milestones

- **M0 — spikes** (order matters; each is ≤1 day):
  - S1: per-app audio escape hatch (1 h; changes the audio roadmap). Test all
    three id forms: `applicationLoopback:<pid>` (include-mode),
    `restrictOwnAudioBrowserLoopback:<discordPid>` (exclude-arbitrary-pid
    hypothesis — powers a live "exclude Discord" toggle), and two simultaneous
    loopback captures (for glitch-free Web Audio crossfade toggling).
  - S2: 1080p60/native@60 simulcast through LiveKit end-to-end (the two-report
    risk flag).
  - S3: Linux `audio: 'loopback'` without the feature flag (20 min).
- **M1 — pure web MVP**: server + viewer + browser publisher on outpost. Friends can
  already use it. Validates tiers, links, TURN, Brazil latency.
- **M2 — Electron shell**: tray → custom picker (thumbnails, audio checkboxes) →
  same pipeline → clipboard link + notification + red-dot tray. Windows first;
  X11/macOS close behind; Wayland uses the portal picker branch
  (`XDG_SESSION_TYPE`, per 02).
- **M3 — audio excellence**: per-app capture UI (if S1 ✓), stereo/bitrate polish,
  mic mixing, RMS self-test, echo guidance.
- **M4 — distribution**: GitHub Releases + checksums, README warning-bypass docs
  (macOS 15 path), winget/Scoop, SignPath application, `verifyUpdateCodeSignature:
  false` auto-update on Windows; macOS "check for updates" opens releases page.
- **Later**: São Paulo media node, E2EE private streams, VP9 mode, viewer voice
  (token flag), link passwords/expiry.

## Engineering guardrails (from research; full lists in 02 §Gotchas and 04 §9)

- No `safeStorage`, no `setLoginItemSettings`, no Squirrel.Mac while unsigned —
  they fail silently on macOS (03).
- Renderer clipboard via `navigator.clipboard`/preload bridge (Electron 44 removed
  the module from renderers).
- Serialize `setDisplayMediaRequestHandler` requests (per-session global — mutex
  with timeout, à la moeru-ai/airi); always resolve the callback, incl. on cancel.
- Reference implementations: `@jitsi/electron-sdk` (picker/Wayland/IPC hygiene),
  moeru-ai/airi (pure-Electron loopback), Cap's `scap-cpal` (WASAPI silence fix,
  MIT), fluxer (AGPL — read, don't copy).
