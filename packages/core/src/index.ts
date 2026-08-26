// @easyscreenshare/core — the shared publish pipeline.
// Runs in both the browser publisher page and the Electron renderer.
// Real capture/publish code arrives in Phase 2 (roadmap step 2.4).

// API types generated from the Rust server by ts-rs (cargo test regenerates).
export type { CreateSessionResponse } from "./generated/CreateSessionResponse";
export type { ViewerTokenResponse } from "./generated/ViewerTokenResponse";

export const CORE_VERSION = "0.1.0";
