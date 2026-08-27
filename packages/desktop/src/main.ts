// easyscreenshare desktop — tray-resident publisher shell.
// 4.2/4.3: custom source picker + publish + clipboard link + tray LIVE state.
//
// Standing guards (docs/research/02, 03, 04): no safeStorage, no
// setLoginItemSettings, no Squirrel.Mac while unsigned; clipboard lives in
// main (renderers lost it in Electron 44); the picker/pipeline window keeps
// backgroundThrottling off; ALWAYS answer the display-media callback.
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
import path from "node:path";

declare const PICKER_VITE_DEV_SERVER_URL: string | undefined;
declare const PICKER_VITE_NAME: string;

const SERVER_URL = process.env.ESS_SERVER ?? "https://easyscreenshare.flipbit03.com";

app.setName("easyscreenshare");
app.setAppUserModelId(
  process.defaultApp ? process.execPath : "com.flipbit03.easyscreenshare",
);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log("easyscreenshare is already running — exiting this instance");
  app.quit();
} else {
  let tray: Tray | null = null;
  let win: BrowserWindow | null = null;
  let live = false;
  let shareUrl = "";
  // Source chosen in our picker; consumed by the display-media handler.
  let chosenSource: { id: string; name: string } | null = null;

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

  const updateTray = () => {
    if (!tray) return;
    tray.setToolTip(live ? "easyscreenshare — LIVE" : "easyscreenshare");
    tray.setContextMenu(
      Menu.buildFromTemplate(
        live
          ? [
              { label: "● LIVE", enabled: false },
              {
                label: "Copy link",
                click: () => {
                  clipboard.writeText(shareUrl);
                },
              },
              { label: "Stop sharing", click: () => requestStop() },
              { type: "separator" },
              { label: "Quit", click: () => quit() },
            ]
          : [
              { label: "Share my screen…", click: () => openPicker() },
              {
                label: "Open web app",
                click: () => void shell.openExternal(SERVER_URL),
              },
              { type: "separator" },
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
    // Give the renderer a beat to disconnect cleanly, then exit.
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
        // The publish pipeline lives here; never throttle it (research 04).
        backgroundThrottling: false,
      },
    });
    win.once("ready-to-show", () => win?.show());
    win.on("close", (e) => {
      if (live) {
        // Closing the window must not kill the stream — hide instead.
        e.preventDefault();
        win?.hide();
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

  // ---------- IPC surface ----------
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

  ipcMain.on("picker:choose", (_e, source: { id: string; name: string }) => {
    chosenSource = source;
  });

  ipcMain.handle("session:create", async () => {
    const res = await fetch(`${SERVER_URL}/api/sessions`, { method: "POST" });
    if (!res.ok) throw new Error(`session create failed: HTTP ${res.status}`);
    return res.json();
  });

  ipcMain.on("share:live", (_e, url: string) => {
    live = true;
    shareUrl = url;
    clipboard.writeText(url);
    updateTray();
    win?.hide();
    try {
      new Notification({
        title: "You're live",
        body: "Link copied — paste it to your friends",
      }).show();
    } catch {
      /* toast support varies for portable apps; tray state is the truth */
    }
  });

  ipcMain.on("share:stopped", () => {
    live = false;
    shareUrl = "";
    chosenSource = null;
    updateTray();
    win?.close();
  });

  app.on("second-instance", () => openPicker());

  void app.whenReady().then(() => {
    // Our picker already chose the source; resolve capture requests directly.
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        if (chosenSource) {
          // audio 'loopback': system audio; the renderer's restrictOwnAudio
          // constraint upgrades it to loopbackWithoutChrome (Electron 43.4+).
          callback({
            video: chosenSource,
            audio: process.platform === "linux" ? undefined : "loopback",
          } as Parameters<typeof callback>[0]);
        } else {
          // ALWAYS answer the callback (research 02) — deny when unarmed.
          callback({} as Parameters<typeof callback>[0]);
        }
      },
    );

    if (process.platform === "darwin") app.dock?.hide();
    try {
      tray = new Tray(trayIcon());
      updateTray();
      console.log("easyscreenshare desktop ready — tray installed");
    } catch (e) {
      console.error("tray unavailable:", e);
      console.log("easyscreenshare desktop ready — NO tray host");
      openPicker(); // no tray = the window is the only entry point
    }
  });

  app.on("window-all-closed", () => {
    /* tray apps keep running with zero windows */
  });
}
