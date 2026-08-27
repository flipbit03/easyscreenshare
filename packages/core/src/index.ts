// @easyscreenshare/core — the shared publish pipeline and API client.
// Runs in both the browser publisher page and the Electron renderer.

export type { CreateSessionResponse } from "./generated/CreateSessionResponse";
export type { ViewerTokenResponse } from "./generated/ViewerTokenResponse";

export {
  createSession,
  fetchViewerToken,
  checkName,
  startHeartbeat,
  NameTakenError,
  StreamNotFoundError,
  type NameAvailability,
} from "./api";
export {
  AUDIO_PRESETS,
  SYSTEM_AUDIO_CONSTRAINTS,
  VIDEO_MODES,
  browserSupportsSystemAudio,
  startScreenShare,
  type AudioPresetName,
  type PublishHandle,
  type StartOptions,
  type VideoModeName,
} from "./publish";

export const CORE_VERSION = "0.1.0";
