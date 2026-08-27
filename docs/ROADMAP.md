# easyscreenshare — Roadmap & Progress Tracker

> The single source of truth for project progress. Work proceeds top to bottom;
> a step is checked `[x]` only when its **Acceptance criteria** are verified
> (not merely coded). **Guards** are invariants that must hold at that step and
> forever after — most trace back to `docs/research/` findings, referenced as
> (01)–(04). Update this file in the same commit as the work it describes.

## Global guards (apply to every step)

- CI must be green before a step is checked; each step lands as a coherent commit/PR.
- New decisions or reversals go into `docs/ARCHITECTURE.md`'s decisions log, same commit.
- Never introduce: `safeStorage`, `setLoginItemSettings`, Squirrel.Mac (unsigned-mac silent failures, 03).
- The top level of the repo stays clean: only workspace manifests, `packages/`, `infra/`, `docs/`, `spikes/`.
- No secrets in the repo — LiveKit keys, deploy keys via env/GHA secrets only.

---

## Phase 0 — Bootstrap

- [x] **0.1 Monorepo scaffold** *(done 2026-08-26 — CI green on initial commit)*
  - Cargo workspace (`packages/server`) + pnpm workspace (`packages/{core,web,desktop}`), MIT `LICENSE`, `README.md` (pitch + docs pointers), `.gitignore`, root `package.json` with pinned `packageManager` (Corepack), CI workflow (build + test, Rust and TS).
  - **Accept:** `cargo build` and `pnpm install && pnpm -r build` succeed locally and in CI.
  - **Guards:** pnpm only via Corepack pin; `packages/server` has no `package.json` (invisible to pnpm); desktop is a stub until Phase 4.

- [x] **0.2 Local LiveKit dev environment** *(done 2026-08-26)*
  - `infra/dev/docker-compose.yml`: `livekit-server` in dev mode with fixed API key/secret; `docs/DEVELOPMENT.md` with the bring-up steps.
  - **Accept:** compose up; `infra/dev/smoke.mjs` mints a dev-key JWT and LiveKit's `/rtc/validate` (the same pre-connect check `livekit-client` performs) returns success. ✔ 200 "success".
  - **Guards:** dev keys clearly marked dev-only; compose file never referenced by prod deploy.

## Phase 1 — Spikes (M0: capability questions, throwaway code in `spikes/`)

- [x] **S1 Per-app audio escape hatch** *(done 2026-08-26 — FIELD verdict on Windows 11: include-mode `applicationLoopback:<pid>` CONFIRMED (Spotify-window share streamed only Spotify audio); exclude-arbitrary-pid REFUTED (silent dead stream); dual-capture untested. Recorded in research 04 §10 + ARCHITECTURE decisions)*
  - Minimal Electron app testing three device-id forms via the picker callback: `applicationLoopback:<pid>` (include), `restrictOwnAudioBrowserLoopback:<otherAppPid>` (exclude-arbitrary hypothesis → live "exclude Discord"), and two simultaneous loopback captures (crossfade toggling).
  - **Accept:** written verdict per id form (works / dead-silent / rejected) appended to `docs/research/04-audio-capture.md`; ARCHITECTURE decisions log updated with the chosen per-app strategy.
  - **Guards:** verify audio by RMS, not by track existence (silent-dead-stream trap, 04 §9.1).
- [ ] **S2 60 fps tier end-to-end** *(partial 2026-08-26, measured in PROD: per-layer fps caps enforce exactly (source 30 → h-layer 31/q-layer 16 per h1080fps30/h720fps15 config), qualityLimitationReason=none at 1080p through EWR, pipeline delivers source fps losslessly. Remaining: 60fps source + custom maxFramerate:60 encoding — needs the tier-config plumbing + a real 60fps capture)*
  - Web publisher → local LiveKit → viewer with custom encodings incl. `maxFramerate: 60` at 1080p/native; measure delivered fps at the viewer (`getStats`).
  - **Accept:** documented delivered-fps table (capture fps vs per-layer received fps); go/no-go on advertising a 60 fps tier; findings appended to research 01.
  - **Guards:** measure with `getStats`, not `track.getSettings()` (02 §3); test with real motion on screen.
- [ ] **S3 Linux loopback without the feature flag** *(needs a REAL Linux desktop — NOT WSL)*
  - Electron `audio: 'loopback'` with NO `PulseaudioLoopbackForScreenShare` flag.
  - Target: a desktop-Linux VM (Ubuntu/Fedora Workstation, e.g. on the Proxmox box —
    QEMU's emulated audio gives a real default sink) or real hardware. WSLg is
    disqualified: RDP-bridged PulseAudio, Weston/XWayland, no real portals — its
    results say nothing about actual distros. Non-blocking: the fallback (always
    set the flag; harmless) lets 4.5 ship Linux tier-2 without this verdict.
  - **Accept:** verdict + fallback decision (set flag always?) recorded in research 04 §10.
  - **Guards:** verify by RMS while audio plays; test both PipeWire and pure-Pulse if available.

## Phase 2 — M1: Web MVP (usable by friends, browser-only)

- [x] **2.1 Server skeleton** *(done 2026-08-26 — image 27.7 MB, /healthz verified in-container)*
  - axum app: config from env, `/healthz`, static file serving, tracing; multi-stage Dockerfile.
  - **Accept:** `curl /healthz` → 200 locally and inside the built image; image < 50 MB.
  - **Guards:** binds localhost-appropriate port from env (Caddy fronts it in prod); stateless.
- [x] **2.2 Session/token API** *(done 2026-08-26 — grants asserted by 5 integration tests; both tokens accepted by local LiveKit /rtc/validate)*
  - `POST /api/sessions` → room id (short, unguessable), publisher JWT (publish-only, room-scoped); `GET /api/sessions/:id/token` → subscriber JWT (subscribe-only, short TTL); LiveKit room as source of truth (no DB); `ts-rs`-generated request/response types consumed by `core`.
  - **Accept:** curl flow against local LiveKit: create session, mint viewer token, both tokens carry exactly the intended grants (decoded + asserted in an integration test).
  - **Guards:** viewer tokens can never publish; token TTL ≤ minutes (rejoin re-mints); room ids from CSPRNG.
- [ ] **2.3 Viewer page** *(built 2026-08-26; automated Chrome e2e ✓: video plays, quality selector switches layers (720×808→944×1060), adaptive initial pick, viewer count, "stream ended" propagation. Pending for tick: Firefox/Safari check + unmute flow with a real audio track)*
  - React + Vite + `livekit-client` (+ `@livekit/components-react` where it helps): join via `/s/:id`, render video + audio, quality selector (Auto/1080/720/Low), volume, fullscreen, viewer count, "stream ended" state.
  - **Accept:** manual e2e vs a test publisher; quality selector visibly switches layers; `adaptiveStream` reacts to window resize; works in Chrome, Firefox, Safari.
  - **Guards:** video starts **muted** with click-to-unmute (browser autoplay policy); viewer never gets publish UI.
- [ ] **2.4 Browser publisher page** *(built 2026-08-26; automated Chrome e2e ✓: session create, publish, share link, 2 concurrent viewers, tier switching, stop flow, honest no-audio banner on Linux window capture. Pending for tick: audio verification on Windows Chrome — stereo at viewer + live preset switch — WSLg cannot capture system audio)*
  - `getDisplayMedia` capture; simulcast encodings (LiveKit screen-share presets + our fps caps); audio with APM-off trio + `restrictOwnAudio`; stereo (`forceStereo`, munging) + audio presets (Voice/Balanced/Music, live-switchable); copy-link UX; honest per-browser audio messaging (04 Matrix B).
  - **Accept:** Chrome full e2e: share screen+audio → 2+ viewers, tiers switch, stereo confirmed at viewer (`getStats` channel count / audible test), audio preset switches live without a blip.
  - **Guards:** `degradationPreference` set explicitly (01 §2 trap); `contentHint` set; capture at native + enforce at encoder (02 §3); Firefox/Safari get a "no audio from this browser" notice, not silent failure.
- [x] **2.5 M1 smoke checklist** *(done 2026-08-26 — executed against prod, 8/10 pass, 1 partial (encoder adaptation, by design), 1 deferred to 3.4; see docs/checklists/m1.md)*
  - Scripted manual checklist: 1 publisher + 3 concurrent viewers (one throttled via devtools), layer adaptation observed, reconnect on network blip, stream-end behavior.
  - **Accept:** checklist executed and committed as `docs/checklists/m1.md` with results.

## Phase 3 — Deploy v0 to outpost

- [x] **3.1 Machine shaping (my_infra playbook)** *(done 2026-08-26 — playbook idempotent (2nd run changed=0), both vhosts 502 over valid LE TLS, DEPLOY_SSH_KEY set as repo secret)*
  - `easyscreenshare` user (docker group) + deploy key + Caddy vhosts (`easyscreenshare.flipbit03.com` → app port, `lk.easyscreenshare.flipbit03.com` → 7880) in a new `easyscreenshare.yaml` playbook, following `2048wars.yaml` exactly. DNS + firewall ports already added in my_infra `iac/vultr` (pending `terraform apply`).
  - **Accept:** playbook idempotent (second run: no changes); vhosts serve 502 (nothing deployed yet) over valid TLS.
  - **Guards:** **do not touch UDP 3478** (headscale DERP) or 443 (Caddy); playbook only shapes what survives redeploys.
- [x] **3.2 Production compose + LiveKit config** *(done 2026-08-26 — livekit v1.13.6 on host networking (bridge advertises container IP — documented trap hit & fixed); media verified flowing via 173.199.119.220:7882)*
  - `infra/prod/`: app + livekit-server; LiveKit: muxed UDP 7882, ICE/TCP 7881, TURN on non-3478 port, keys via env; DNS records.
  - **Accept:** deployed by hand once; public viewer page loads; wss signaling connects; media flows from a home publisher to an external viewer.
  - **Guards:** verify Vultr firewall passes UDP 7882 (open question from infra review); LiveKit config file in repo, secrets out.
- [x] **3.3 GHA deploy pipeline** *(done 2026-08-26 — 4 successful deploys via workflow_dispatch incl. config-only redeploys; health gate works)*
  - Build → GHCR → scp compose → ssh `docker compose up` → `/healthz` gate, keyed to releases + `workflow_dispatch` (2048wars pattern).
  - **Accept:** one release deploys green end-to-end; re-deploy of previous tag works (rollback path).
- [ ] **3.4 Real-world Brazil test**
  - Friends test: publisher in Brazil, viewers incl. **a 4G phone** (CGNAT/TURN path) and, if available, a corporate/UDP-blocked network; measure glass-to-glass latency vs EWR.
  - **Accept:** results (who connected via which ICE candidate type, latency) recorded in `docs/checklists/v0-field-test.md`; decision logged: stay EWR / spin São Paulo.
  - **Guards:** force-relay test (`iceTransportPolicy: 'relay'`) must succeed — proves TURN before real users need it.

## Phase 4 — M2: Electron tray app (Windows first)

- [ ] **4.1 App scaffold** — Forge + Vite plugin, tray icon + menu, single-instance lock, no visible window by default. *(built 2026-08-26; verified on Linux/WSLg: boots, tray installs, single-instance lock works (`app.setName` pinned so all launch modes share it), typecheck in CI. Pending for tick: tray visual on Windows — user run. Note: pnpm needed `publicHoistPattern` for the electron toolchain + registry override for @electron/node-gyp, both in pnpm-workspace.yaml)*
  - **Accept:** `pnpm --filter desktop start` shows tray on Windows; second launch focuses the first.
  - **Guards:** clipboard via preload bridge only (Electron 44 removed renderer clipboard, 02).
- [x] **4.2 Custom source picker** *(done 2026-08-26 — thumbnails+icons picker shipped in portable exe, used in the field)* — window with screen/window thumbnails + app icons, system-audio checkbox (default ON), mic checkbox (default **OFF**).
  - **Accept:** picker lists sources with live thumbnails; cancel path resolves cleanly; picking starts capture.
  - **Guards:** request-ID map for concurrent `getDisplayMedia` (02); ALWAYS call the callback incl. cancel; handler serialized behind a mutex (04 §9.12); Wayland branch stub (`XDG_SESSION_TYPE`) falls back to portal.
- [x] **4.3 Publish + link flow** *(done 2026-08-26 — tray→pick→clipboard link→viewer watched Spotify stream with per-app audio; tray LIVE menu with Copy link/Stop)* — reuse `core` pipeline; on start: link in clipboard, native notification, tray icon red; tray menu: copy link / stop / quality.
  - **Accept:** tray click → pick → link pasted to a friend → they watch, < 10 s of clicks; stop kills the room (viewers see "ended").
  - **Guards:** `powerSaveBlocker('prevent-display-sleep')` during share; audio constraints identical to 2.4 (APM off etc.).
- [ ] **4.4 Quality + audio preset menus** — video tier cap (Auto/1080p60/1080p30/720p30…) and audio preset (Voice/Balanced/Music) switchable **while live**.
  - **Accept:** switching either mid-stream is seamless for viewers (audio: no blip; video: layer change only).
- [ ] **4.5 Linux (X11 + Wayland-portal) and macOS best-effort builds**
  - **Accept:** X11: custom picker + loopback audio (per S3 verdict); Wayland: portal picker path works; macOS: runs ad-hoc-signed, `NSAudioCaptureUsageDescription` present, RMS self-test surfaces missing-permission as a real error.
  - **Guards:** macOS Info.plist key ships from the FIRST build (silent-dead-stream, 04); tray: no right-click on Linux — all actions in left-click menu.
- [ ] **4.6 Packaged artifacts** — Windows: ONE portable .exe (no installer; `make:win` via forge package + electron-builder portable, already working from WSL); Linux: AppImage/zip; macOS: zip (ad-hoc signed). SHA256 checksums; README install docs incl. unsigned-app bypass (03). Ship as GitHub Release attachments once minimally stable.
  - **Accept:** a friend installs from the artifact alone (no dev tooling) and shares successfully.

## Phase 5 — M3: Audio excellence

- [ ] **5.1 Audio diagnostics** — in-app self-test: capture 200 ms, assert non-zero RMS + channel count + `getSettings` APM flags; surfaced in UI on failure.
- [ ] **5.2 Per-app capture UI** *(built 2026-08-26, awaiting field verdict: screen shares now use a ZERO-NATIVE per-app mixer — one include-mode capture per windowed tree root, Web Audio mix, exclusions as zero-gain (instant Discord toggle, mid-stream launches covered by 5s poll). Window share = that-app-only audio remains field-confirmed. Chromium source verified: no exclude-arbitrary-app device id exists. Field risks: N concurrent app-loopback captures; gestureless follow-up gDM (activation poked via sendInputEvent))*
  - **Accept:** with Discord playing voice + game audio: viewers hear game only, toggle works mid-stream.
- [ ] **5.3 Mic opt-in path** — Web Audio mixer (per-source gain), APM on for mic, RNNoise opt-in.
  - **Accept:** mic never captured unless enabled (verify: no `getUserMedia` call, no OS mic indicator); mix levels adjustable live.
  - **Guards:** never process the desktop track (04); `backgroundThrottling: false` on the pipeline window.
- [ ] **5.4 WASAPI silence keepalive** — silent render stream trick (04 §9.5).
  - **Accept:** stream started during total silence delivers audio from the first played sound.

## Phase 6 — M4: Distribution

- [ ] **6.1 Release pipeline** — tagged releases build all artifacts + checksums to GitHub Releases.
- [ ] **6.2 winget + Scoop manifests** (bypass SmartScreen via package managers, 03).
- [ ] **6.3 SignPath Foundation application** (Windows signing; requires public repo, MIT ✓).
- [ ] **6.4 Auto-update** — Windows via `electron-updater` + `verifyUpdateCodeSignature: false` (03); macOS/Linux: "check for updates" opens releases page.

## Backlog (unordered, post-v1)

- [ ] São Paulo media node (when 3.4 says latency hurts) — LiveKit-only box, same pattern.
- [ ] E2EE "private stream" toggle — key in URL fragment (01 §6).
- [ ] VP9 "sharp text" opt-in codec mode.
- [ ] Link passwords / expiry / kick-all (needs SQLite in server).
- [ ] Viewer talk-back (token grant flip) — only if Discord-voice assumption stops holding.
- [ ] Browser-publisher parity niceties: pause/resume, source switching (`surfaceSwitching`).
