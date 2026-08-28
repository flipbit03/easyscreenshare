// easyscreenshare desktop — tray-resident publisher shell.
//
// Audio routing (all zero-native-code, field-informed by S1):
//   - window share → ONLY that app's audio: single include-mode capture
//     (applicationLoopback:<pid> — S1 CONFIRMED).
//   - screen share → per-app MIXER: one include-mode capture per windowed
//     process-tree root, mixed in the renderer via Web Audio. Exclusions
//     (Discord by default) are gain nodes at zero — instant toggles, and
//     apps appearing mid-stream get wired into the live graph. Chromium has
//     NO exclude-arbitrary-app device id (verified against Chromium source),
//     so exclusion-by-mixing is the zero-native path.
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
/** Normalized (lowercase, no .exe) names muted by the Discord toggle. */
const DISCORD_APPS = ["discord", "discordptb", "discordcanary"];

type AudioPresetName = "voice" | "balanced" | "music";
type VideoModeName = "motion" | "text";

interface Settings {
  audioPreset: AudioPresetName;
  videoMode: VideoModeName;
  excludedApps: string[];
  /** Public streams need no PIN. Default: closed. */
  publicStream: boolean;
  /** Balloon when a viewer joins. */
  notifyJoins: boolean;
}

export interface AudioRoot {
  pid: number;
  name: string; // normalized: lowercase, no extension
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
  /** Single-capture audio for the main/window gDM call. */
  let baseAudio: "loopback" | { id: string; name: string } | undefined;
  /** One-shot arm for the mixer's next capture (consumed by the handler). */
  let mixerArmPid: number | null = null;
  /** Whether the current share uses the per-app mixer. */
  let mixerActive = false;
  let lastRoots: AudioRoot[] = [];
  let pollTimer: NodeJS.Timeout | null = null;
  /** include-mode target for window shares. */
  let appTarget: { pid: number; exe: string } | null = null;
  /** Viewer roster pushed from the renderer (names from tokens). */
  interface ViewerRow {
    identity: string;
    name: string;
    conn: string;
    joinedAt: number;
  }
  let viewerRows: ViewerRow[] = [];
  let currentPin: string | null = null;

  const ago = (ts: number): string => {
    const m = Math.floor(Math.max(0, Date.now() - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""} ago`;
  };

  const balloon = (title: string, content: string) => {
    try {
      if (process.platform === "win32" && tray) {
        tray.displayBalloon({ title, content, iconType: "info" });
      } else {
        new Notification({ title, body: content }).show();
      }
    } catch {
      /* tray state is the fallback truth */
    }
  };

  // ---------- settings ----------
  const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
  const settings: Settings = (() => {
    const defaults: Settings = {
      audioPreset: "balanced",
      videoMode: "motion",
      excludedApps: [...DISCORD_APPS],
      publicStream: false,
      notifyJoins: true,
    };
    try {
      const loaded = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
      return { ...defaults, ...loaded };
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
        { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
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
    v == null
      ? []
      : Array.isArray(v)
        ? (v as Record<string, unknown>[])
        : [v as Record<string, unknown>];

  const normName = (s: string) => s.toLowerCase().replace(/\.exe$/, "");

  /** Windowed process-tree ROOTS: every process with a real window whose
   * ancestors have no window of their own. Capturing each root's tree
   * (applicationLoopback includes descendants) covers browsers' audio
   * subprocesses; silent apps just contribute zeros to the mix. */
  const listAudioRoots = async (): Promise<AudioRoot[]> => {
    const data = (await psJson(
      `$p = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name; ` +
        `$w = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -ExpandProperty Id; ` +
        `@{procs=$p; windowed=$w} | ConvertTo-Json -Depth 4 -Compress`,
    )) as { procs?: unknown; windowed?: unknown } | null;
    if (!data) return [];
    const procs = asArray(data.procs).map((r) => ({
      pid: Number(r.ProcessId),
      ppid: Number(r.ParentProcessId),
      name: normName(String(r.Name ?? "")),
    }));
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const windowed = new Set(
      (Array.isArray(data.windowed) ? data.windowed : [data.windowed]).map(Number),
    );
    const hasWindowedAncestor = (pid: number): boolean => {
      let cur = byPid.get(pid)?.ppid;
      const seen = new Set<number>();
      while (cur && byPid.has(cur) && !seen.has(cur)) {
        if (windowed.has(cur)) return true;
        seen.add(cur);
        cur = byPid.get(cur)?.ppid;
      }
      return false;
    };
    const roots: AudioRoot[] = [];
    for (const p of procs) {
      if (!windowed.has(p.pid)) continue;
      if (hasWindowedAncestor(p.pid)) continue;
      if (p.pid === process.pid) continue;
      if (p.name === "easyscreenshare") continue; // never capture ourselves
      roots.push({ pid: p.pid, name: p.name });
    }
    return roots;
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

  // ---------- audio arming ----------
  const armForChoice = async (): Promise<{
    mixer: boolean;
    roots: AudioRoot[];
    excludedApps: string[];
  }> => {
    mixerActive = false;
    appTarget = null;
    lastRoots = [];
    if (process.platform === "linux") {
      baseAudio = undefined; // tier 2: no loopback arming (research 04)
      return { mixer: false, roots: [], excludedApps: [] };
    }
    if (process.platform !== "win32") {
      baseAudio = "loopback";
      return { mixer: false, roots: [], excludedApps: [] };
    }
    if (chosenSource && !chosenSource.isScreen) {
      // Window share → single include-mode capture (S1 CONFIRMED).
      appTarget = await windowProcessByTitle(chosenSource.name);
      if (appTarget) {
        baseAudio = { id: `applicationLoopback:${appTarget.pid}`, name: "App audio" };
        return { mixer: false, roots: [], excludedApps: [] };
      }
      baseAudio = "loopback";
      return { mixer: false, roots: [], excludedApps: [] };
    }
    // Screen share → per-app mixer.
    baseAudio = undefined; // mixer supplies the track; main gDM is video-only
    lastRoots = await listAudioRoots();
    mixerActive = true;
    return { mixer: true, roots: lastRoots, excludedApps: settings.excludedApps };
  };

  /** Real input event so follow-up getDisplayMedia calls carry activation. */
  const pokeActivation = () => {
    win?.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 });
    win?.webContents.sendInputEvent({
      type: "mouseDown",
      x: 2,
      y: 2,
      button: "left",
      clickCount: 1,
    });
    win?.webContents.sendInputEvent({
      type: "mouseUp",
      x: 2,
      y: 2,
      button: "left",
      clickCount: 1,
    });
  };

  const startPolling = () => {
    stopPolling();
    if (process.platform !== "win32") return;
    pollTimer = setInterval(() => {
      void (async () => {
        if (!live || !chosenSource) return;
        if (mixerActive) {
          const now = await listAudioRoots();
          const nowPids = new Set(now.map((r) => r.pid));
          const prevPids = new Set(lastRoots.map((r) => r.pid));
          const add = now.filter((r) => !prevPids.has(r.pid));
          const remove = [...prevPids].filter((p) => !nowPids.has(p));
          if (add.length || remove.length) {
            lastRoots = now;
            win?.webContents.send("audio:mixer-sync", { add, remove });
            updateTray(); // exclusions submenu follows the live app list
          }
        } else if (appTarget && chosenSource) {
          const again = await windowProcessByTitle(chosenSource.name);
          if (again && again.pid !== appTarget.pid) {
            appTarget = again;
            baseAudio = { id: `applicationLoopback:${again.pid}`, name: "App audio" };
            win?.webContents.send("audio:rearm");
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

  const discordMuted = () =>
    DISCORD_APPS.every((a) => settings.excludedApps.includes(a));

  const setAppExcluded = (name: string, excluded: boolean) => {
    const setNames = DISCORD_APPS.includes(name) ? DISCORD_APPS : [name];
    settings.excludedApps = settings.excludedApps.filter(
      (a) => !setNames.includes(a),
    );
    if (excluded) settings.excludedApps.push(...setNames);
    saveSettings();
    if (live && mixerActive)
      win?.webContents.send("audio:exclude-set", settings.excludedApps);
    updateTray();
  };

  const exclusionItems = (): Electron.MenuItemConstructorOptions[] => {
    const items: Electron.MenuItemConstructorOptions[] = [
      {
        label: "Mute Discord in stream",
        type: "checkbox",
        checked: discordMuted(),
        click: (item) => setAppExcluded("discord", item.checked),
      },
    ];
    const others = lastRoots.filter(
      (r) => !DISCORD_APPS.includes(r.name) && r.name !== "explorer",
    );
    if (others.length) items.push({ type: "separator" });
    for (const r of others) {
      items.push({
        label: `Mute ${r.name}`,
        type: "checkbox",
        checked: settings.excludedApps.includes(r.name),
        click: (item) => setAppExcluded(r.name, item.checked),
      });
    }
    return items;
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
      submenu: exclusionItems(),
    },
    {
      label: "Access",
      submenu: [
        {
          label: "Public stream (no PIN)",
          type: "checkbox",
          checked: settings.publicStream,
          enabled: !live, // applies to the NEXT stream
          click: (item) => {
            settings.publicStream = item.checked;
            saveSettings();
          },
        },
        {
          label: "Notify when someone joins",
          type: "checkbox",
          checked: settings.notifyJoins,
          click: (item) => {
            settings.notifyJoins = item.checked;
            saveSettings();
          },
        },
      ],
    },
  ];

  /** Header: "● LIVE" + PIN + per-connection-type counts, then the roster
   * submenu with per-viewer Kick + New PIN. */
  const viewerHeader = (): Electron.MenuItemConstructorOptions[] => {
    const lines: Electron.MenuItemConstructorOptions[] = [
      { label: "● LIVE", enabled: false },
    ];
    if (currentPin) lines.push({ label: `PIN: ${currentPin}`, enabled: false });
    if (viewerRows.length === 0) {
      lines.push({ label: "no viewers yet", enabled: false });
      return lines;
    }
    const groups = new Map<string, number>();
    for (const v of viewerRows) groups.set(v.conn, (groups.get(v.conn) ?? 0) + 1);
    for (const [conn, n] of groups) {
      lines.push({
        label: `${n} ${n === 1 ? "viewer" : "viewers"} (${conn})`,
        enabled: false,
      });
    }
    lines.push({
      label: `Viewers (${viewerRows.length})`,
      submenu: viewerRows.map((v) => ({
        label: `${v.name} · joined ${ago(v.joinedAt)} · ${v.conn}`,
        submenu: [
          {
            label: "Kick + New PIN",
            click: () => win?.webContents.send("viewer:kick", v.identity),
          },
        ],
      })),
    });
    return lines;
  };

  const updateTray = () => {
    if (!tray) return;
    tray.setToolTip(
      live
        ? `easyscreenshare v${app.getVersion()} — LIVE: ${viewerRows.length} ${
            viewerRows.length === 1 ? "viewer" : "viewers"
          }`
        : `easyscreenshare v${app.getVersion()}`,
    );
    tray.setContextMenu(
      Menu.buildFromTemplate(
        live
          ? [
              ...viewerHeader(),
              { type: "separator" },
              { label: "Copy link", click: () => clipboard.writeText(shareUrl) },
              {
                label: "Copy link + PIN",
                visible: currentPin != null,
                click: () =>
                  clipboard.writeText(`${shareUrl} · PIN: ${currentPin}`),
              },
              {
                label: "Change what you're sharing…",
                click: () => {
                  openPicker();
                  win?.webContents.send("picker:switch");
                },
              },
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
              { label: `easyscreenshare v${app.getVersion()}`, enabled: false },
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
      return armForChoice();
    },
  );

  ipcMain.handle("audio:arm", (_e, pid: number) => {
    mixerArmPid = pid;
    pokeActivation();
  });

  ipcMain.on("viewers:update", (_e, rows: ViewerRow[]) => {
    const known = new Set(viewerRows.map((v) => v.identity));
    if (live && settings.notifyJoins) {
      for (const v of rows) {
        if (!known.has(v.identity)) {
          balloon(`${v.name} is watching`, `${rows.length} viewer${rows.length === 1 ? "" : "s"} now`);
        }
      }
    }
    viewerRows = rows;
    if (live) updateTray();
  });

  ipcMain.on(
    "pin:rotated",
    (_e, info: { pin: string | null; kickedName: string }) => {
      currentPin = info.pin;
      updateTray();
      balloon(
        `Kicked ${info.kickedName}`,
        info.pin ? `New PIN: ${info.pin}` : "Viewer removed",
      );
    },
  );

  ipcMain.handle("settings:get", () => settings);

  ipcMain.handle("app:server-url", () => SERVER_URL);

  ipcMain.on("picker:hide", () => win?.hide());

  ipcMain.on(
    "share:live",
    (_e, info: { shareUrl: string; pin: string | null }) => {
      live = true;
      shareUrl = info.shareUrl;
      currentPin = info.pin;
      clipboard.writeText(
        info.pin ? `${info.shareUrl} · PIN: ${info.pin}` : info.shareUrl,
      );
      updateTray();
      startPolling();
      win?.hide();
      balloon(
        "You're live",
        info.pin
          ? `Link + PIN copied — PIN: ${info.pin}`
          : "Link copied — paste it to your friends",
      );
    },
  );

  ipcMain.on("share:stopped", () => {
    live = false;
    shareUrl = "";
    currentPin = null;
    viewerRows = [];
    chosenSource = null;
    appTarget = null;
    mixerActive = false;
    mixerArmPid = null;
    stopPolling();
    updateTray();
    win?.close();
  });

  app.on("second-instance", () => openPicker());

  void app.whenReady().then(() => {
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      if (!chosenSource) {
        callback({} as Parameters<typeof callback>[0]); // ALWAYS answer (02)
        return;
      }
      if (mixerArmPid != null) {
        // A mixer capture: same video source (discarded by the renderer),
        // audio locked to one app's process tree.
        const pid = mixerArmPid;
        mixerArmPid = null;
        callback({
          video: { id: chosenSource.id, name: chosenSource.name },
          audio: { id: `applicationLoopback:${pid}`, name: "App audio" },
        } as unknown as Parameters<typeof callback>[0]);
        return;
      }
      callback({
        video: { id: chosenSource.id, name: chosenSource.name },
        audio: baseAudio,
      } as unknown as Parameters<typeof callback>[0]);
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
