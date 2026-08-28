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
}

const api = {
  serverUrl: (): Promise<string> => ipcRenderer.invoke("app:server-url"),
  listSources: (): Promise<SourceInfo[]> => ipcRenderer.invoke("picker:list"),
  chooseSource: (source: {
    id: string;
    name: string;
    isScreen: boolean;
  }): Promise<ArmResult> => ipcRenderer.invoke("picker:choose", source),
  armAudio: (pid: number): Promise<void> => ipcRenderer.invoke("audio:arm", pid),
  getSettings: (): Promise<{
    audioPreset: "voice" | "balanced" | "music";
    videoMode: "motion" | "text";
    excludedApps: string[];
    publicStream: boolean;
    notifyJoins: boolean;
    liveBorder: boolean;
  }> => ipcRenderer.invoke("settings:get"),
  notifyLive: (info: { shareUrl: string; pin: string | null }) =>
    ipcRenderer.send("share:live", info),
  notifyStopped: () => ipcRenderer.send("share:stopped"),
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
  onAudioPreset: (cb: (name: "voice" | "balanced" | "music") => void) => {
    ipcRenderer.on("settings:audio", (_e, name) => cb(name));
  },
  onVideoMode: (cb: (name: "motion" | "text") => void) => {
    ipcRenderer.on("settings:video", (_e, name) => cb(name));
  },
};

export type EssBridge = typeof api;

contextBridge.exposeInMainWorld("ess", api);
