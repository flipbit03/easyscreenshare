//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
let electron = require("electron");
let node_path = require("node:path");
node_path = __toESM(node_path);
//#region src/main.ts
var WEB_URL = "https://easyscreenshare.flipbit03.com";
electron.app.setName("easyscreenshare");
electron.app.setAppUserModelId(process.defaultApp ? process.execPath : "com.flipbit03.easyscreenshare");
if (!electron.app.requestSingleInstanceLock()) {
	console.log("easyscreenshare is already running — exiting this instance");
	electron.app.quit();
} else {
	electron.app.on("second-instance", () => {
		console.log("second instance launched — already running");
	});
	let tray = null;
	const trayIconPath = () => {
		const dir = electron.app.isPackaged ? node_path.default.join(process.resourcesPath, "assets") : node_path.default.join(electron.app.getAppPath(), "assets");
		const file = process.platform === "darwin" ? "trayTemplate.png" : "tray.png";
		return node_path.default.join(dir, file);
	};
	const buildMenu = () => electron.Menu.buildFromTemplate([
		{
			label: "Share my screen…",
			enabled: false,
			toolTip: "coming in 4.2"
		},
		{
			label: "Open web app",
			click: () => void electron.shell.openExternal(WEB_URL)
		},
		{ type: "separator" },
		{
			label: `easyscreenshare ${electron.app.getVersion()}`,
			enabled: false
		},
		{
			label: "Quit",
			role: "quit"
		}
	]);
	electron.app.whenReady().then(() => {
		if (process.platform === "darwin") electron.app.dock?.hide();
		try {
			const icon = electron.nativeImage.createFromPath(trayIconPath());
			tray = new electron.Tray(icon);
			tray.setToolTip("easyscreenshare");
			tray.setContextMenu(buildMenu());
			console.log("easyscreenshare desktop ready — tray installed");
		} catch (e) {
			console.error("tray unavailable:", e);
			console.log("easyscreenshare desktop ready — NO tray host");
		}
	});
	electron.app.on("window-all-closed", () => {});
}
//#endregion
