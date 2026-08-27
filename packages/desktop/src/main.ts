// easyscreenshare desktop — tray-resident publisher shell.
// Custom picker, publish, clipboard link, tray LIVE state, quality submenus,
// and per-app audio routing:
//   - window share  → ONLY that app's audio (applicationLoopback:<pid> via
//     Electron's display-media escape hatch — S1 CONFIRMED in the field)
//   - screen share  → whole system audio (exclude-arbitrary-pid ids are a
//     silent dead stream — S1 REFUTED; Discord exclusion awaits a native
//     audio module, roadmap 5.2)
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
} from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

declare const PICKER_VITE_DEV_SERVER_URL: string | undefined;
declare const PICKER_VITE_NAME: string;

const SERVER_URL = process.env.ESS_SERVER ?? "https://easyscreenshare.flipbit03.com";
const DISCORD_EXES = ["Discord.exe", "DiscordPTB.exe", "DiscordCanary.exe"];

type AudioPresetName = "voice" | "balanced" | "music";
type VideoModeName = "motion" | "text";

interface Settings {
  audioPreset: AudioPresetName;
  videoMode: VideoModeName;
  excludeDiscord: boolean;
}

app.setName("easyscreenshare");
app.setAppUserModelId(
  process.defaultApp ? process.execPath : "com.flipbit03.easyscreenshare",
);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log("easyscreenshare is already running — exiting this instance");
  app.quit();
} else {
  main();
}

function main() {
  let tray: Tray | null = null;
  let win: BrowserWindow | null = null;
  let live = false;
  let shareUrl = "";
  let chosenSource: { id: string; name: string; isScreen: boolean } | null = null;
  /** Device the display-media handler answers with. Recomputed by arm(). */
  let armedAudio: "loopback" | { id: string; name: string } | undefined;
  /** Whether the per-app device ids work on this system (S1 verdict). */
  let perAppSupported = true;
  /** include-mode target for window shares: resolved process. */
  let appTarget: { pid: number; exe: string } | null = null;
  /** exclude-mode target while screen-sharing. */
  let excludedPid: number | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  // ---------- settings ----------
  const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
  const settings: Settings = (() => {
    const defaults: Settings = {
      audioPreset: "balanced",
      videoMode: "motion",
      excludeDiscord: true,
    };
    try {
      return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
    } catch {
      return defaults;
    }
  })();
  const saveSettings = () => {
    try {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    } catch (e) {
      console.error("settings save failed:", e);
    }
  };

  // ---------- process helpers (Windows) ----------
  const psJson = (cmd: string): Promise<unknown> =>
    new Promise((resolve) => {
      if (process.platform !== "win32") return resolve(null);
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", cmd],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout.trim()) return resolve(null);
          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve(null);
          }
        },
      );
    });

  const asArray = (v: unknown): Record<string, unknown>[] =>
    v == null ? [] : Array.isArray(v) ? (v as Record<string, unknown>[]) : [v as Record<string, unknown>];

  /** Root of Discord's process tree (audio children live under it). */
  const discordRootPid = async (): Promise<number | null> => {
    const filter = DISCORD_EXES.map((e) => `Name='${e}'`).join(" OR ");
    const rows = asArray(
      await psJson(
        `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId | ConvertTo-Json`,
      ),
    );
    if (!rows.length) return null;
    const pids = new Set(rows.map((r) => Number(r.ProcessId)));
    const root = rows.find((r) => !pids.has(Number(r.ParentProcessId)));
    return root ? Number(root.ProcessId) : Number(rows[0].ProcessId);
  };

  /** Owning process of a shared window, resolved by its title. */
  const windowProcessByTitle = async (
    title: string,
  ): Promise<{ pid: number; exe: string } | null> => {
    const esc = title.replace(/'/g, "''");
    const rows = asArray(
      await psJson(
        `Get-Process | Where-Object { $_.MainWindowTitle -eq '${esc}' } | Select-Object Id,ProcessName | ConvertTo-Json`,
      ),
    );
    if (!rows.length) return null;
    return { pid: Number(rows[0].Id), exe: String(rows[0].ProcessName) };
  };

  const pidAlive = async (pid: number): Promise<boolean> =>
    asArray(
      await psJson(`Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object Id | ConvertTo-Json`),
    ).length > 0;

  // ---------- audio arming ----------
  const arm = async () => {
    if (process.platform === "linux") {
      armedAudio = undefined; // whole-system only, tier 2 (research 04)
      return;
    }
    if (!chosenSource) {
      armedAudio = "loopback";
      return;
    }
    if (!chosenSource.isScreen && perAppSupported && process.platform === "win32") {
      // Window share → ONLY that app's audio.
      appTarget = await windowProcessByTitle(chosenSource.name);
      if (appTarget) {
        armedAudio = {
          id: `applicationLoopback:${appTarget.pid}`,
          name: "App audio",
        };
        return;
      }
    }
    appTarget = null;
    // Screen share (or window pid unresolved) → whole system audio.
    // S1 field verdict (2026-08-26): exclude-arbitrary-pid device ids produce
    // a SILENT DEAD STREAM — Discord exclusion needs a native audio module
    // (roadmap 5.2). Include-mode (window shares) is confirmed working.
    excludedPid = null;
    armedAudio = "loopback";
  };

  const rearmLive = async () => {
    await arm();
    win?.webContents.send("audio:rearm");
  };

  const startPolling = () => {
    stopPolling();
    if (process.platform !== "win32") return;
    pollTimer = setInterval(() => {
      void (async () => {
        if (!live || !chosenSource) return;
        if (appTarget) {
          // include-mode: follow the app across restarts
          if (!(await pidAlive(appTarget.pid))) {
            const again = await windowProcessByTitle(chosenSource.name);
            const byExe = again ?? null; // title may have changed; best effort
            if (byExe && byExe.pid !== appTarget.pid) await rearmLive();
          }
        }
      })();
    }, 5000);
  };
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  // ---------- tray ----------
  const assetsDir = () =>
    app.isPackaged
      ? path.join(process.resourcesPath, "assets")
      : path.join(app.getAppPath(), "assets");

  const trayIcon = () =>
    nativeImage.createFromPath(
      path.join(
        assetsDir(),
        process.platform === "darwin" ? "trayTemplate.png" : "tray.png",
      ),
    );

  const AUDIO_LABELS: Record<AudioPresetName, string> = {
    voice: "Voice — talking",
    balanced: "Balanced",
    music: "Music — high quality",
  };
  const VIDEO_LABELS: Record<VideoModeName, string> = {
    motion: "Smooth motion — games, video",
    text: "Sharp text — code, docs",
  };

  const settingsSubmenus = (): Electron.MenuItemConstructorOptions[] => [
    {
      label: "Video",
      submenu: (Object.keys(VIDEO_LABELS) as VideoModeName[]).map((key) => ({
        label: VIDEO_LABELS[key],
        type: "radio" as const,
        checked: settings.videoMode === key,
        click: () => {
          settings.videoMode = key;
          saveSettings();
          if (live) win?.webContents.send("settings:video", key);
        },
      })),
    },
    {
      label: "Audio quality",
      submenu: (Object.keys(AUDIO_LABELS) as AudioPresetName[]).map((key) => ({
        label: AUDIO_LABELS[key],
        type: "radio" as const,
        checked: settings.audioPreset === key,
        click: () => {
          settings.audioPreset = key;
          saveSettings();
          if (live) win?.webContents.send("settings:audio", key);
        },
      })),
    },
    {
      label: "Audio exclusions",
      visible: process.platform === "win32",
      submenu: [
        {
          label: "Mute Discord in stream (soon — needs native audio capture)",
          type: "checkbox",
          checked: false,
          enabled: false,
        },
        {
          label: "Tip: share the app's window to stream only its audio",
          enabled: false,
        },
      ],
    },
  ];

  const updateTray = () => {
    if (!tray) return;
    tray.setToolTip(live ? "easyscreenshare — LIVE" : "easyscreenshare");
    tray.setContextMenu(
      Menu.buildFromTemplate(
        live
          ? [
              { label: "● LIVE", enabled: false },
              { label: "Copy link", click: () => clipboard.writeText(shareUrl) },
              { label: "Stop sharing", click: () => requestStop() },
              { type: "separator" },
              ...settingsSubmenus(),
              { type: "separator" },
              { label: "Quit", click: () => quit() },
            ]
          : [
              { label: "Share my screen…", click: () => openPicker() },
              { type: "separator" },
              ...settingsSubmenus(),
              { type: "separator" },
              {
                label: "Open web app",
                click: () => void shell.openExternal(SERVER_URL),
              },
              { label: `easyscreenshare ${app.getVersion()}`, enabled: false },
              { label: "Quit", click: () => quit() },
            ],
      ),
    );
  };

  const requestStop = () => {
    win?.webContents.send("share:stop");
  };

  const quit = () => {
    if (live) requestStop();
    setTimeout(() => app.exit(0), 400);
  };

  const openPicker = () => {
    if (win) {
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: 820,
      height: 620,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#0b0e14",
      title: "easyscreenshare",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        backgroundThrottling: false, // publish pipeline lives here (research 04)
      },
    });
    win.once("ready-to-show", () => win?.show());
    win.on("close", (e) => {
      if (live) {
        e.preventDefault();
        win?.hide(); // closing must not kill the stream
      }
    });
    win.on("closed", () => {
      win = null;
    });
    if (PICKER_VITE_DEV_SERVER_URL) {
      void win.loadURL(PICKER_VITE_DEV_SERVER_URL);
    } else {
      void win.loadFile(
        path.join(__dirname, `../renderer/${PICKER_VITE_NAME}/index.html`),
      );
    }
  };

  // ---------- IPC ----------
  ipcMain.handle("picker:list", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 360, height: 202 },
      fetchWindowIcons: true,
    });
    return sources
      .filter((s) => s.name !== "easyscreenshare")
      .map((s) => ({
        id: s.id,
        name: s.name,
        isScreen: s.id.startsWith("screen:"),
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      }));
  });

  ipcMain.handle(
    "picker:choose",
    async (_e, source: { id: string; name: string; isScreen: boolean }) => {
      chosenSource = source;
      await arm();
      return { perApp: appTarget != null, excludedDiscord: excludedPid != null };
    },
  );

  ipcMain.handle("settings:get", () => settings);

  ipcMain.handle("session:create", async () => {
    const res = await fetch(`${SERVER_URL}/api/sessions`, { method: "POST" });
    if (!res.ok) throw new Error(`session create failed: HTTP ${res.status}`);
    return res.json();
  });

  ipcMain.handle("audio:exclusion-unsupported", async () => {
    // S1 verdict from the field: the per-app device ids don't work here.
    if (!perAppSupported) return false;
    perAppSupported = false;
    console.log("per-app audio device ids unsupported — falling back to loopback");
    await arm();
    updateTray();
    return true; // caller should retry once
  });

  ipcMain.on("share:live", (_e, url: string) => {
    live = true;
    shareUrl = url;
    clipboard.writeText(url);
    updateTray();
    startPolling();
    win?.hide();
    try {
      new Notification({
        title: "You're live",
        body: "Link copied — paste it to your friends",
      }).show();
    } catch {
      /* toast support varies for portable apps */
    }
  });

  ipcMain.on("share:stopped", () => {
    live = false;
    shareUrl = "";
    chosenSource = null;
    appTarget = null;
    excludedPid = null;
    stopPolling();
    updateTray();
    win?.close();
  });

  app.on("second-instance", () => openPicker());

  void app.whenReady().then(() => {
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      if (chosenSource) {
        callback({
          video: { id: chosenSource.id, name: chosenSource.name },
          audio: armedAudio,
        } as unknown as Parameters<typeof callback>[0]);
      } else {
        callback({} as Parameters<typeof callback>[0]); // ALWAYS answer (02)
      }
    });

    if (process.platform === "darwin") app.dock?.hide();
    try {
      tray = new Tray(trayIcon());
      updateTray();
      console.log("easyscreenshare desktop ready — tray installed");
    } catch (e) {
      console.error("tray unavailable:", e);
      console.log("easyscreenshare desktop ready — NO tray host");
      openPicker();
    }
  });

  app.on("window-all-closed", () => {
    /* tray apps keep running with zero windows */
  });
}
