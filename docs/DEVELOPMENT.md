# Development

## Prerequisites

- Rust (stable) + Cargo
- Node 24 + Corepack (`corepack enable`) — pnpm version is pinned in `package.json`
- Docker (for the local LiveKit server)

## First-time setup

```bash
pnpm install
cargo build
```

## Everyday commands

```bash
pnpm -r build          # build all TS packages
pnpm -r lint           # oxlint
cargo build            # build the server
cargo run              # run the API server (PORT env, default 8090)
curl localhost:8090/healthz
```

## Local LiveKit

The media server runs in Docker, in dev mode with well-known credentials
(**API key `devkey`, secret `secret` — local only, never used in any deploy**):

```bash
docker compose -f infra/dev/docker-compose.yml up -d
node infra/dev/smoke.mjs     # mints a dev JWT and validates it against LiveKit
```

Ports: 7880 (WS signaling + HTTP), 7881 (ICE/TCP), 7882/udp (media).

## Where things are

- `docs/ROADMAP.md` — current step, acceptance criteria, what's next
- `docs/ARCHITECTURE.md` — design + decisions log
- `docs/research/` — the sourced research behind the decisions
