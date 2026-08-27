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

const api = {
  listSources: (): Promise<SourceInfo[]> => ipcRenderer.invoke("picker:list"),
  /** Arms the display-media handler (source + audio routing). Resolves with
   * what got armed so the UI can say "app audio only" / "Discord muted". */
  chooseSource: (source: {
    id: string;
    name: string;
    isScreen: boolean;
  }): Promise<{ perApp: boolean; excludedDiscord: boolean }> =>
    ipcRenderer.invoke("picker:choose", source),
  getSettings: (): Promise<{
    audioPreset: "voice" | "balanced" | "music";
    videoMode: "motion" | "text";
    excludeDiscord: boolean;
  }> => ipcRenderer.invoke("settings:get"),
  createSession: (): Promise<{
    sessionId: string;
    shareUrl: string;
    publisherToken: string;
    livekitUrl: string;
  }> => ipcRenderer.invoke("session:create"),
  /** Reports that per-app device ids failed; true = disarmed, retry once. */
  reportExclusionUnsupported: (): Promise<boolean> =>
    ipcRenderer.invoke("audio:exclusion-unsupported"),
  notifyLive: (shareUrl: string) => ipcRenderer.send("share:live", shareUrl),
  notifyStopped: () => ipcRenderer.send("share:stopped"),
  onStopRequested: (cb: () => void) => {
    ipcRenderer.on("share:stop", cb);
  },
  onAudioRearm: (cb: () => void) => {
    ipcRenderer.on("audio:rearm", cb);
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
