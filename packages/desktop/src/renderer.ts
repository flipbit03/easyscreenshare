// Picker + publish pipeline renderer. Vanilla DOM — the surface is one grid.
import { RoomEvent } from "livekit-client";
import {
  NameTakenError,
  SYSTEM_AUDIO_CONSTRAINTS,
  checkName,
  createSession,
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
let serverUrl = "";
void window.ess.serverUrl().then((u) => (serverUrl = u));

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
  app.replaceChildren();
  const head = h("header", "head");
  head.append(
    h("h1", undefined, mode === "switch" ? "Switch source" : "Share your screen"),
  );
  head.append(
    h(
      "p",
      "sub",
      "A screen streams per-app mixed audio (Discord muted by default) — a window streams only that app's audio.",
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
  }

  const grid = h("div", "grid");
  app.append(grid);

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

/** Build the audio track for a source per its arm plan. Manages `mixer` and
 * returns { track (undefined = let the video capture supply app audio), sub }. */
async function buildAudio(
  source: SourceInfo,
  armed: ArmResult,
): Promise<{ track?: MediaStreamTrack; sub: string }> {
  mixer?.stop();
  mixer = null;
  if (armed.mixer) {
    mixer = new AppAudioMixer(window.ess, armed.excludedApps);
    const ok = await mixer.addAll(armed.roots);
    if (ok === 0) {
      mixer.stop();
      mixer = null;
      return { sub: "Audio: system (per-app mix unavailable)" };
    }
    const muted = armed.excludedApps.length ? " — Discord muted" : "";
    return { track: mixer.track, sub: `Audio: ${ok} apps mixed${muted}` };
  }
  // Window / fallback: the video capture itself carries the app's audio.
  return { sub: source.isScreen ? "Audio: system" : "Audio: this app only" };
}

async function startShare(source: SourceInfo) {
  renderStatus("Starting…");
  try {
    const armed = await window.ess.chooseSource({
      id: source.id,
      name: source.name,
      isScreen: source.isScreen,
    });
    const settings = await window.ess.getSettings();
    if (armed.mixer) renderStatus("Starting…", false, "capturing app audio…");
    const audio = await buildAudio(source, armed);

    const sess = await createSession(vanityName.trim() || undefined, serverUrl);
    handle = await startScreenShare({
      livekitUrl: sess.livekitUrl,
      token: sess.publisherToken,
      audio: true,
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
    window.ess.notifyLive(sess.shareUrl);
    renderStatus("You're live — this window can stay hidden.", false, audio.sub);
  } catch (e) {
    mixer?.stop();
    mixer = null;
    handle = null;
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
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: source.isScreen ? false : SYSTEM_AUDIO_CONSTRAINTS,
    } as DisplayMediaStreamOptions);
    const newVideo = stream.getVideoTracks()[0];
    if (newVideo) await handle.replaceVideoTrack(newVideo);

    const audio = await buildAudio(source, armed);
    if (audio.track) {
      await handle.replaceAudioTrack(audio.track);
    } else {
      const appAudio = stream.getAudioTracks()[0];
      if (appAudio) await handle.replaceAudioTrack(appAudio);
    }
    window.ess.hidePicker();
  } catch (e) {
    renderStatus(e instanceof Error ? e.message : String(e), true);
  }
}

/** Report viewer count + connection-type breakdown to main for the tray. */
function watchViewers(hd: PublishHandle) {
  const push = () => {
    const groups = new Map<string, number>();
    let count = 0;
    for (const p of hd.room.remoteParticipants.values()) {
      if (!p.identity.startsWith("viewer-")) continue;
      count++;
      const key = p.attributes?.conn ?? "connecting…";
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    window.ess.updateViewers({ count, groups: [...groups.entries()] });
  };
  hd.room
    .on(RoomEvent.ParticipantConnected, push)
    .on(RoomEvent.ParticipantDisconnected, push)
    .on(RoomEvent.ParticipantAttributesChanged, push);
  push();
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
  window.ess.notifyStopped();
}

window.ess.onStopRequested(() => void stopShare());
window.ess.onSwitchSource(() => void renderPicker("switch"));
window.ess.onAudioRearm(() => void rearmAudio());
window.ess.onMixerSync((diff) => void mixer?.sync(diff));
window.ess.onExcludeSet((list) => mixer?.setExcluded(list));
window.ess.onAudioPreset((name) => void handle?.setAudioPreset(name));
window.ess.onVideoMode((name) => void handle?.setVideoMode(name));

void renderPicker();
