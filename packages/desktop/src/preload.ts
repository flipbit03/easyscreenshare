// Bridge between the picker/pipeline renderer and main. Clipboard, capture
// source enumeration, and session creation all live in main.
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
  chooseSource: (source: { id: string; name: string }) =>
    ipcRenderer.send("picker:choose", source),
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
};

export type EssBridge = typeof api;

contextBridge.exposeInMainWorld("ess", api);
