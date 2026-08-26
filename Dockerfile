# ---- web (TS) build
FROM node:24-slim AS webbuild
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY packages/web packages/web
RUN pnpm -r build

# ---- server (Rust) build
FROM rust:1.95-slim AS rustbuild
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY packages/server packages/server
RUN cargo build --release -p easyscreenshare-server

# ---- runtime
FROM gcr.io/distroless/cc-debian12
COPY --from=rustbuild /src/target/release/easyscreenshare-server /app/server
COPY --from=webbuild /src/packages/web/dist /app/web
ENV STATIC_DIR=/app/web
ENV PORT=8090
EXPOSE 8090
ENTRYPOINT ["/app/server"]
