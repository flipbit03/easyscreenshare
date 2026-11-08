// Bridge between the picker/pipeline renderer and main. Capture-source
// enumeration and audio arming live in main; session creation + heartbeat run
// in the renderer via @easyscreenshare/core (CORS is enabled server-side).
import { contextBridge, ipcRenderer } from "electron";

export interface SourceInfo {
  id: string;
  name: string;
  isScreen: boolean;
  thumbnail: string | null;
  appIcon: string | null;
}

export interface AudioRoot {
  pid: number;
  name: string;
}

export interface ArmResult {
  mixer: boolean;
  roots: AudioRoot[];
  excludedApps: string[];
  /** What the stream audio contains: per-app mix, one app, whole system, or none. */
  audioScope: "none" | "system" | "app" | "mixer";
  /** Linux router: input device label to capture with getUserMedia. */
  linuxSource?: string;
  /** Linux router: the single app being streamed, if any. */
  onlyApp?: string | null;
}

export interface ViewerRow {
  identity: string;
  name: string;
  conn: string;
  joinedAt: number;
}

/** Main's live snapshot — the window renders its controls from this. */
export interface LiveState {
  live: boolean;
  trayVisible: boolean;
  shareUrl: string;
  pin: string | null;
  hasAudio: boolean;
  muted: boolean;
  failed: string[];
  viewers: ViewerRow[];
  perApp: boolean;
  canOnly: boolean;
  apps: string[];
  discordMuted: boolean;
  onlyApp: string | null;
  excludedApps: string[];
  videoMode: string;
  audioPreset: string;
  videoModes: { key: string; label: string }[];
  audioPresets: { key: string; label: string }[];
}

export type LiveAction =
  | { t: "copy"; pin: boolean }
  | { t: "mute"; v: boolean }
  | { t: "only"; app: string | null }
  | { t: "exclude"; app: string; v: boolean }
  | { t: "video"; v: string }
  | { t: "audioPreset"; v: string };

const api = {
  liveState: (): Promise<LiveState> => ipcRenderer.invoke("live:state"),
  liveAction: (a: LiveAction) => ipcRenderer.send("live:action", a),
  onLiveState: (cb: (s: LiveState) => void) => {
    ipcRenderer.on("live:state", (_e, s) => cb(s));
  },
  serverUrl: (): Promise<string> => ipcRenderer.invoke("app:server-url"),
  /** Wayland = the xdg-desktop-portal dialog replaces our source grid. */
  platform: (): Promise<{ platform: string; wayland: boolean }> =>
    ipcRenderer.invoke("app:platform"),
  listSources: (): Promise<SourceInfo[]> => ipcRenderer.invoke("picker:list"),
  /** onlyApp (Linux): stream just this app; null = all apps; omitted = keep. */
  chooseSource: (
    source: { id: string; name: string; isScreen: boolean },
    onlyApp?: string | null,
  ): Promise<ArmResult> => ipcRenderer.invoke("picker:choose", source, onlyApp),
  /** Linux: apps currently playing audio (normalized names). */
  streamApps: (): Promise<string[]> => ipcRenderer.invoke("audio:apps"),
  armAudio: (pid: number): Promise<void> => ipcRenderer.invoke("audio:arm", pid),
  /** Mixer came up empty — re-arm the main capture for full system loopback. */
  armSystemLoopback: (): Promise<void> => ipcRenderer.invoke("audio:loopback"),
  /** Apps the mixer could not capture; main surfaces them (balloon + tray). */
  reportCaptureFailures: (names: string[]) =>
    ipcRenderer.send("audio:capture-failed", names),
  getSettings: (): Promise<{
    audioPreset: "voice" | "balanced" | "music";
    videoMode: "motion" | "text";
    excludedApps: string[];
    publicStream: boolean;
    notifyJoins: boolean;
    shareAudio: boolean;
  }> => ipcRenderer.invoke("settings:get"),
  setShareAudio: (v: boolean) => ipcRenderer.send("settings:share-audio", v),
  notifyLive: (info: { shareUrl: string; pin: string | null; hasAudio: boolean }) =>
    ipcRenderer.send("share:live", info),
  notifyStopped: () => ipcRenderer.send("share:stopped"),
  /** A share failed to start: drop any audio routing set up for it. */
  releaseAudio: () => ipcRenderer.send("audio:release"),
  hidePicker: () => ipcRenderer.send("picker:hide"),
  updateViewers: (
    rows: { identity: string; name: string; conn: string; joinedAt: number }[],
  ) => ipcRenderer.send("viewers:update", rows),
  notifyPinRotated: (info: { pin: string | null; kickedName: string }) =>
    ipcRenderer.send("pin:rotated", info),
  onKickViewer: (cb: (identity: string) => void) => {
    ipcRenderer.on("viewer:kick", (_e, identity) => cb(identity));
  },
  onStopRequested: (cb: () => void) => {
    ipcRenderer.on("share:stop", cb);
  },
  onSwitchSource: (cb: () => void) => {
    ipcRenderer.on("picker:switch", cb);
  },
  onAudioRearm: (cb: () => void) => {
    ipcRenderer.on("audio:rearm", cb);
  },
  onMixerSync: (cb: (diff: { add: AudioRoot[]; remove: number[] }) => void) => {
    ipcRenderer.on("audio:mixer-sync", (_e, diff) => cb(diff));
  },
  onExcludeSet: (cb: (excludedApps: string[]) => void) => {
    ipcRenderer.on("audio:exclude-set", (_e, list) => cb(list));
  },
  onAudioMute: (cb: (muted: boolean) => void) => {
    ipcRenderer.on("audio:mute", (_e, muted) => cb(muted));
  },
  onAudioPreset: (cb: (name: "voice" | "balanced" | "music") => void) => {
    ipcRenderer.on("settings:audio", (_e, name) => cb(name));
  },
  onVideoMode: (cb: (name: "motion" | "text") => void) => {
    ipcRenderer.on("settings:video", (_e, name) => cb(name));
  },
};

export type EssBridge = typeof api;

contextBridge.exposeInMainWorld("ess", api);
