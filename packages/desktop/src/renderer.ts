// Picker + publish pipeline renderer. Vanilla DOM — the surface is one grid.
import { RoomEvent } from "livekit-client";
import {
  NameTakenError,
  SYSTEM_AUDIO_CONSTRAINTS,
  checkName,
  createSession,
  kickViewer,
  startScreenShare,
  type PublishHandle,
} from "@easyscreenshare/core";
import { AppAudioMixer } from "./mixer";
import type { ArmResult, EssBridge, SourceInfo } from "./preload";
import "./picker.css";

declare global {
  interface Window {
    ess: EssBridge;
  }
}

const NAME_KEY = "ess:name";
const app = document.getElementById("app")!;
let handle: PublishHandle | null = null;
let mixer: AppAudioMixer | null = null;
let vanityName = localStorage.getItem(NAME_KEY) ?? "";
let session: { id: string; secret: string } | null = null;
let serverUrl = "";
void window.ess.serverUrl().then((u) => (serverUrl = u));
const platformInfo = window.ess.platform();

/** Stand-in source on Wayland: main swaps in the portal's real pick. */
const PORTAL_SOURCE: SourceInfo = {
  id: "portal",
  name: "Screen or window",
  isScreen: true,
  thumbnail: null,
  appIcon: null,
};

/** The portal dialog was dismissed — not an error worth a red screen. */
const isCancel = (e: unknown) =>
  e instanceof DOMException &&
  (e.name === "NotAllowedError" || e.name === "AbortError");

const AUDIO_SUB: Record<ArmResult["audioScope"], string> = {
  none: "Audio: off",
  system: "Audio: everything your computer plays",
  app: "Audio: this app only",
  mixer: "Audio: apps mixed",
};

/** Linux: picker's "stream audio from" choice for the next share. */
let onlyApp: string | null = null;

/** Linux: open the router's virtual source by label. Labels need no prior
 * mic grant in Electron (permission checks default to allow); the device can
 * take a moment to show up after the module loads, so retry briefly. */
async function captureLinuxSource(label: string): Promise<MediaStreamTrack> {
  for (let i = 0; i < 10; i++) {
    const dev = (await navigator.mediaDevices.enumerateDevices()).find(
      (d) => d.kind === "audioinput" && d.label.includes(label),
    );
    if (dev) {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { ...SYSTEM_AUDIO_CONSTRAINTS, deviceId: { exact: dev.deviceId } },
      });
      return s.getAudioTracks()[0];
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`audio device "${label}" not found`);
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}

/** mode "start" begins a new share; "switch" swaps the source of the live one. */
async function renderPicker(mode: "start" | "switch" = "start") {
  const { platform, wayland } = await platformInfo;
  app.replaceChildren();
  const head = h("header", "head");
  head.append(
    h("h1", undefined, mode === "switch" ? "Switch source" : "Share your screen"),
  );
  head.append(
    h(
      "p",
      "sub",
      platform === "win32"
        ? "A screen streams per-app mixed audio (Discord muted by default) — a window streams only that app's audio."
        : platform === "linux"
          ? "Streams every app's audio except muted ones (Discord muted by default) — or just one app. Change it live from the tray."
          : "Audio is everything your computer plays (including voice chat).",
    ),
  );
  app.append(head);

  if (mode === "start") {
    const nameRow = h("div", "name-row");
    const field = h("label", "name-field");
    field.append(h("span", "name-prefix", "/s/"));
    const input = h("input") as HTMLInputElement;
    input.type = "text";
    input.placeholder = "custom name (optional)";
    input.value = vanityName;
    input.maxLength = 32;
    const badge = h("span", "name-badge");
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const setStatus = (status: string, text: string) => {
      field.className = `name-field name-${status}`;
      badge.className = `name-badge name-badge-${status}`;
      badge.textContent = text;
    };
    const runCheck = () => {
      const n = vanityName.trim();
      if (n) localStorage.setItem(NAME_KEY, n);
      else localStorage.removeItem(NAME_KEY);
      if (!n) return setStatus("idle", "");
      setStatus("checking", "checking…");
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const r = await checkName(n, serverUrl);
        if (!r.valid) setStatus("invalid", n.length < 3 ? "too short" : "invalid");
        else if (r.available) setStatus("available", "free ✓");
        else setStatus("taken", "taken");
      }, 350);
    };
    input.addEventListener("input", () => {
      input.value = input.value.replace(/[^A-Za-z0-9_-]/g, "");
      vanityName = input.value;
      runCheck();
    });
    field.append(input);
    field.append(badge);
    nameRow.append(field);
    app.append(nameRow);
    if (vanityName) runCheck(); // re-check the remembered name

    const audioRow = h("label", "audio-row");
    const audioCb = h("input") as HTMLInputElement;
    audioCb.type = "checkbox";
    audioCb.checked = (await window.ess.getSettings()).shareAudio;
    audioCb.addEventListener("change", () =>
      window.ess.setShareAudio(audioCb.checked),
    );
    audioRow.append(audioCb, h("span", undefined, "Share audio"));
    app.append(audioRow);

    if (platform === "linux") {
      // Only apps holding an audio stream right now are listed; anything
      // that starts later can be picked live from the tray.
      const row = h("label", "audio-row");
      const sel = h("select", "audio-select") as HTMLSelectElement;
      const opt = (value: string, text: string) => {
        const o = h("option", undefined, text) as HTMLOptionElement;
        o.value = value;
        return o;
      };
      sel.append(opt("", "All apps (except muted)"));
      for (const a of await window.ess.streamApps()) sel.append(opt(a, `Only ${a}`));
      sel.value = onlyApp ?? "";
      if (sel.value !== (onlyApp ?? "")) onlyApp = null; // app went away
      sel.addEventListener("change", () => (onlyApp = sel.value || null));
      sel.disabled = !audioCb.checked;
      audioCb.addEventListener("change", () => (sel.disabled = !audioCb.checked));
      row.append(h("span", undefined, "Audio from"), sel);
      app.append(row);
    }
  }

  const grid = h("div", "grid");
  app.append(grid);

  if (wayland) {
    // xdg-desktop-portal owns source selection on Wayland: one button that
    // opens the system dialog (KDE/GNOME draw it, not us).
    const go = h("button", "retry portal-btn", "Choose screen or window…");
    go.addEventListener("click", () =>
      void (mode === "switch"
        ? switchSource(PORTAL_SOURCE)
        : startShare(PORTAL_SOURCE)),
    );
    grid.append(go);
    return;
  }

  const sources = await window.ess.listSources();
  if (sources.length === 0) {
    grid.append(h("p", "empty", "No capturable sources found."));
    return;
  }

  const addSection = (label: string, items: SourceInfo[]) => {
    if (!items.length) return;
    grid.append(h("div", "section-label", label));
    const row = h("div", "cards");
    grid.append(row);
    for (const s of items) {
      const card = h("button", "card");
      card.title = s.name;
      if (s.thumbnail) {
        const img = h("img", "thumb") as HTMLImageElement;
        img.src = s.thumbnail;
        img.alt = "";
        card.append(img);
      } else {
        card.append(h("div", "thumb thumb-empty"));
      }
      const cap = h("div", "caption");
      if (s.appIcon) {
        const icon = h("img", "appicon") as HTMLImageElement;
        icon.src = s.appIcon;
        icon.alt = "";
        cap.append(icon);
      }
      cap.append(h("span", "name", s.name));
      card.append(cap);
      card.addEventListener("click", () =>
        void (mode === "switch" ? switchSource(s) : startShare(s)),
      );
      row.append(card);
    }
  };
  addSection("Screens", sources.filter((s) => s.isScreen));
  addSection("Windows", sources.filter((s) => !s.isScreen));
}

function renderStatus(text: string, isError = false, sub?: string) {
  app.replaceChildren();
  const box = h("div", "status");
  box.append(h("p", isError ? "err" : undefined, text));
  if (sub) box.append(h("p", "substatus", sub));
  if (isError) {
    const back = h("button", "retry", "Back to picker");
    back.addEventListener("click", () => void renderPicker());
    box.append(back);
  }
  app.append(box);
}

/** Build the audio track per the arm plan. Manages `mixer` and
 * returns { track (undefined = let the video capture supply app audio), sub }. */
async function buildAudio(
  armed: ArmResult,
): Promise<{ track?: MediaStreamTrack; sub: string }> {
  mixer?.stop();
  mixer = null;
  if (armed.mixer) {
    mixer = new AppAudioMixer(window.ess, armed.excludedApps);
    const ok = await mixer.addAll(armed.roots);
    window.ess.reportCaptureFailures(mixer.failedNames);
    if (ok === 0) {
      mixer.stop();
      mixer = null;
      // Real fallback: one full system-loopback capture. No per-app
      // exclusions, but full audio beats silence.
      await window.ess.armSystemLoopback();
      return { sub: "Audio: system (per-app mix unavailable)" };
    }
    const muted = armed.excludedApps.length ? " — Discord muted" : "";
    return { track: mixer.track, sub: `Audio: ${ok} apps mixed${muted}` };
  }
  if (armed.linuxSource) {
    try {
      const track = await captureLinuxSource(armed.linuxSource);
      const discord = armed.excludedApps.includes("discord") ? " — Discord muted" : "";
      return {
        track,
        sub: armed.onlyApp
          ? `Audio: only ${armed.onlyApp}`
          : `Audio: all apps except muted${discord}`,
      };
    } catch (e) {
      console.error("per-app audio unavailable:", e);
      await window.ess.armSystemLoopback(); // whole system beats silence
      return { sub: "Audio: everything your computer plays (per-app unavailable)" };
    }
  }
  // Window / system loopback: the video capture itself carries the audio.
  return { sub: AUDIO_SUB[armed.audioScope] };
}

async function startShare(source: SourceInfo) {
  renderStatus("Starting…");
  let audioTrack: MediaStreamTrack | undefined;
  try {
    const armed = await window.ess.chooseSource(
      { id: source.id, name: source.name, isScreen: source.isScreen },
      onlyApp,
    );
    const settings = await window.ess.getSettings();
    if (armed.mixer) renderStatus("Starting…", false, "capturing app audio…");
    const audio = settings.shareAudio
      ? await buildAudio(armed)
      : { track: undefined, sub: "Audio: off" };
    audioTrack = audio.track;

    const sess = await createSession(
      { name: vanityName.trim() || undefined, public: settings.publicStream },
      serverUrl,
    );
    session = { id: sess.sessionId, secret: sess.sessionSecret };
    handle = await startScreenShare({
      livekitUrl: sess.livekitUrl,
      token: sess.publisherToken,
      audio: settings.shareAudio,
      audioPreset: settings.audioPreset,
      videoMode: settings.videoMode,
      audioTrackOverride: audio.track,
      heartbeat: {
        sessionId: sess.sessionId,
        secret: sess.sessionSecret,
        baseUrl: serverUrl,
      },
    });
    handle.onEnded(() => void stopShare());
    watchViewers(handle);
    window.ess.notifyLive({
      shareUrl: sess.shareUrl,
      pin: sess.pin,
      hasAudio: handle.hasAudio,
    });
    renderStatus(
      "You're live — this window can stay hidden.",
      false,
      handle.hasAudio
        ? audio.sub
        : settings.shareAudio
          ? "Audio: unavailable here — video only"
          : "Audio: off",
    );
  } catch (e) {
    mixer?.stop();
    mixer = null;
    handle = null;
    // Not live: stop our capture FIRST, then release the router's source —
    // the other order makes Chromium fail over to another input (the mic).
    audioTrack?.stop();
    window.ess.releaseAudio();
    if (isCancel(e)) return void renderPicker();
    if (e instanceof NameTakenError) {
      renderStatus(`"${vanityName}" is in use right now — pick another name.`, true);
    } else {
      renderStatus(e instanceof Error ? e.message : String(e), true);
    }
  }
}

/** Swap the live source (screen ↔ window) without dropping the stream/link. */
async function switchSource(source: SourceInfo) {
  if (!handle) return void renderPicker();
  renderStatus("Switching…");
  try {
    const armed = await window.ess.chooseSource({
      id: source.id,
      name: source.name,
      isScreen: source.isScreen,
    });
    // New video (+ app audio when it's a window share) from the new source.
    const settings = await window.ess.getSettings();
    // Audio rides on the capture unless the per-app mixer supplies it
    // (window shares on Windows, system loopback on Linux/macOS).
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio:
        armed.mixer || armed.linuxSource || !settings.shareAudio
          ? false
          : SYSTEM_AUDIO_CONSTRAINTS,
    } as DisplayMediaStreamOptions);
    const newVideo = stream.getVideoTracks()[0];
    if (newVideo) await handle.replaceVideoTrack(newVideo);

    const audio = await buildAudio(armed);
    if (audio.track) {
      await handle.replaceAudioTrack(audio.track);
    } else {
      const appAudio = stream.getAudioTracks()[0];
      if (appAudio) await handle.replaceAudioTrack(appAudio);
    }
    window.ess.hidePicker();
  } catch (e) {
    if (isCancel(e)) return void window.ess.hidePicker(); // keep the old source
    renderStatus(e instanceof Error ? e.message : String(e), true);
  }
}

/** Report the viewer roster (name, conn, joined time) to main for the tray. */
const joinedAt = new Map<string, number>();
function watchViewers(hd: PublishHandle) {
  const push = () => {
    const rows: {
      identity: string;
      name: string;
      conn: string;
      joinedAt: number;
    }[] = [];
    for (const p of hd.room.remoteParticipants.values()) {
      if (!p.identity.startsWith("viewer-")) continue;
      if (!joinedAt.has(p.identity)) {
        joinedAt.set(
          p.identity,
          p.joinedAt ? p.joinedAt.getTime() : Date.now(),
        );
      }
      rows.push({
        identity: p.identity,
        name: p.name || "Someone",
        conn: p.attributes?.conn ?? "connecting…",
        joinedAt: joinedAt.get(p.identity)!,
      });
    }
    rows.sort((a, b) => a.joinedAt - b.joinedAt);
    window.ess.updateViewers(rows);
  };
  joinedAt.clear();
  hd.room
    .on(RoomEvent.ParticipantConnected, push)
    .on(RoomEvent.ParticipantDisconnected, push)
    .on(RoomEvent.ParticipantAttributesChanged, push);
  push();
}

/** Tray-initiated kick: rotate PIN + drop the connection, report back. */
async function kickByIdentity(identity: string) {
  if (!session) return;
  const name =
    [...(handle?.room.remoteParticipants.values() ?? [])].find(
      (p) => p.identity === identity,
    )?.name || "viewer";
  try {
    const r = await kickViewer(session.id, session.secret, identity, serverUrl);
    window.ess.notifyPinRotated({
      pin: r.pin,
      kickedName: r.disconnected ? name : `${name} (connection not dropped)`,
    });
  } catch (e) {
    console.error("kick failed", e);
  }
}

/** Single-capture rearm (window shares: the app restarted). */
async function rearmAudio() {
  if (!handle || mixer) return;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    } as DisplayMediaStreamOptions);
    for (const t of stream.getVideoTracks()) t.stop();
    const audio = stream.getAudioTracks()[0];
    if (audio) await handle.replaceAudioTrack(audio);
  } catch {
    // keep the current audio track — better stale routing than silence
  }
}

async function stopShare() {
  const hd = handle;
  handle = null;
  if (hd) await hd.stop().catch(() => {});
  mixer?.stop();
  mixer = null;
  session = null;
  window.ess.notifyStopped();
}

window.ess.onStopRequested(() => void stopShare());
window.ess.onKickViewer((identity) => void kickByIdentity(identity));
window.ess.onSwitchSource(() => void renderPicker("switch"));
window.ess.onAudioRearm(() => void rearmAudio());
window.ess.onMixerSync((diff) => {
  if (!mixer) return;
  void mixer.sync(diff).then(() => {
    window.ess.reportCaptureFailures(mixer?.failedNames ?? []);
  });
});
window.ess.onExcludeSet((list) => mixer?.setExcluded(list));
window.ess.onAudioMute((muted) => void handle?.setAudioMuted(muted));
window.ess.onAudioPreset((name) => void handle?.setAudioPreset(name));
window.ess.onVideoMode((name) => void handle?.setVideoMode(name));

void renderPicker();
