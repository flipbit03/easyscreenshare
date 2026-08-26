# easyscreenshare

**Click the tray icon → pick what to share → a link is in your clipboard.
Anyone who opens the link watches in their browser. That's it.**

Born the week Brazil lost Discord screensharing (ANPD order, August 2026).
This replaces exactly that one feature — not Discord: voice chat stays wherever
you already have it.

- **Publisher**: an Electron tray app (Windows/Linux/macOS) — or straight from
  a Chromium browser, no install, with reduced audio features.
- **Viewers**: any browser, no account, no install, watch-only.
- **Quality**: Discord-style tiers — 720p/1080p/native × 15/30/60 fps,
  viewer-selectable and bandwidth-adaptive (WebRTC simulcast via LiveKit).
- **Audio is the point**: system audio on all three OSes, music-grade stereo
  Opus (up to 256 kbps, voice-processing off), sharer-side quality presets,
  and (in progress) per-app capture — "share the game, not Discord."
- **Self-hostable**: one Rust binary + LiveKit in docker compose behind Caddy.

## Status

Early development. See [`docs/ROADMAP.md`](docs/ROADMAP.md) for exactly where
we are — checkboxes are kept honest.

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The design + every decision with rationale |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Step-by-step plan with acceptance criteria |
| [`docs/research/`](docs/research/) | The 2026 state-of-the-art research this is built on (SFU/distribution, Electron capture, OSS signing, desktop audio) — every claim sourced |

## Repository layout

```
packages/
  server/    Rust (axum): sessions, LiveKit tokens, short links, serves the web app
  core/      TypeScript: the shared publish pipeline (browser + Electron)
  web/       Viewer page + browser publisher (React + Vite)
  desktop/   Electron tray app (Phase 4 — not started)
infra/       docker compose + deploy
docs/        you are here
```

## License

[MIT](LICENSE)
