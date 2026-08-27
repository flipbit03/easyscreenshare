// Bridge between the picker/pipeline renderer and main. Clipboard, capture
// source enumeration, audio arming, and session creation all live in main.
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
  listSources: (): Promise<SourceInfo[]> => ipcRenderer.invoke("picker:list"),
  /** Arms the display-media handler for the chosen source and reports the
   * audio plan: per-app mixer (screen shares) or single capture. */
  chooseSource: (source: {
    id: string;
    name: string;
    isScreen: boolean;
  }): Promise<ArmResult> => ipcRenderer.invoke("picker:choose", source),
  /** Arms the NEXT getDisplayMedia call to capture one app's audio. */
  armAudio: (pid: number): Promise<void> => ipcRenderer.invoke("audio:arm", pid),
  getSettings: (): Promise<{
    audioPreset: "voice" | "balanced" | "music";
    videoMode: "motion" | "text";
    excludedApps: string[];
  }> => ipcRenderer.invoke("settings:get"),
  createSession: (): Promise<{
    sessionId: string;
    shareUrl: string;
    publisherToken: string;
    livekitUrl: string;
  }> => ipcRenderer.invoke("session:create"),
  notifyLive: (shareUrl: string) => ipcRenderer.send("share:live", shareUrl),
  notifyStopped: () => ipcRenderer.send("share:stopped"),
  onStopRequested: (cb: () => void) => {
    ipcRenderer.on("share:stop", cb);
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
