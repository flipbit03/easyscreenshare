// easyscreenshare desktop — tray-resident publisher shell.
// Phase 4.1: tray + single instance. Capture/publish arrive in 4.2/4.3.
//
// Standing guards (docs/research/02, 03): no safeStorage, no
// setLoginItemSettings, no Squirrel.Mac while unsigned — they fail silently
// on unsigned macOS builds.
import { app, Menu, nativeImage, shell, Tray } from "electron";
import path from "node:path";

const WEB_URL = "https://easyscreenshare.flipbit03.com";

// One identity for every launch mode (forge dev, packaged, `electron .`):
// the single-instance lock is keyed on userData, which follows the app name.
app.setName("easyscreenshare");

// Windows toasts need an AppUserModelID; in dev the exe path stands in.
app.setAppUserModelId(process.defaultApp ? process.execPath : "com.flipbit03.easyscreenshare");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log("easyscreenshare is already running — exiting this instance");
  app.quit();
} else {
  app.on("second-instance", () => {
    // 4.2+: focus/open the picker. For now the tray is the whole UI.
    console.log("second instance launched — already running");
  });

  let tray: Tray | null = null;

  const trayIconPath = () => {
    const dir = app.isPackaged
      ? path.join(process.resourcesPath, "assets")
      : path.join(app.getAppPath(), "assets");
    // macOS wants a Template image (auto-tinted); Windows/Linux get the
    // orange dot.
    const file = process.platform === "darwin" ? "trayTemplate.png" : "tray.png";
    return path.join(dir, file);
  };

  const buildMenu = () =>
    Menu.buildFromTemplate([
      { label: "Share my screen…", enabled: false, toolTip: "coming in 4.2" },
      { label: "Open web app", click: () => void shell.openExternal(WEB_URL) },
      { type: "separator" },
      { label: `easyscreenshare ${app.getVersion()}`, enabled: false },
      { label: "Quit", role: "quit" },
    ]);

  void app.whenReady().then(() => {
    // Tray-only app: no window until the user acts.
    if (process.platform === "darwin") app.dock?.hide();
    try {
      const icon = nativeImage.createFromPath(trayIconPath());
      tray = new Tray(icon);
      tray.setToolTip("easyscreenshare");
      tray.setContextMenu(buildMenu());
      console.log("easyscreenshare desktop ready — tray installed");
    } catch (e) {
      // Some Linux environments (e.g. WSLg/Weston) have no tray host.
      console.error("tray unavailable:", e);
      console.log("easyscreenshare desktop ready — NO tray host");
    }
  });

  // Tray apps keep running with zero windows.
  app.on("window-all-closed", () => {
    /* keep alive */
  });
}
