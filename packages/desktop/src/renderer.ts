// Picker + publish pipeline renderer. Vanilla DOM — the surface is one grid.
import { RoomEvent } from "livekit-client";
import { startScreenShare, type PublishHandle } from "@easyscreenshare/core";
import { AppAudioMixer } from "./mixer";
import type { EssBridge, SourceInfo } from "./preload";
import "./picker.css";

declare global {
  interface Window {
    ess: EssBridge;
  }
}

const app = document.getElementById("app")!;
let handle: PublishHandle | null = null;
let mixer: AppAudioMixer | null = null;

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

async function renderPicker() {
  app.replaceChildren();
  const head = h("header", "head");
  head.append(h("h1", undefined, "Share your screen"));
  head.append(
    h(
      "p",
      "sub",
      "A screen streams per-app mixed audio (Discord muted by default) — a window streams only that app's audio.",
    ),
  );
  app.append(head);

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
      card.addEventListener("click", () => void startShare(s));
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

async function startShare(source: SourceInfo) {
  renderStatus("Starting…");
  try {
    const armed = await window.ess.chooseSource({
      id: source.id,
      name: source.name,
      isScreen: source.isScreen,
    });
    const settings = await window.ess.getSettings();

    // Screen shares: build the per-app mix BEFORE the main capture so its
    // track can be published as the stream audio.
    let audioSub = "Audio: system";
    if (armed.mixer) {
      renderStatus("Starting…", false, "capturing app audio…");
      mixer = new AppAudioMixer(window.ess, armed.excludedApps);
      const ok = await mixer.addAll(armed.roots);
      if (ok === 0) {
        // Mixer produced nothing — fall back to plain system loopback so
        // the share still carries audio.
        mixer.stop();
        mixer = null;
        audioSub = "Audio: system (per-app mix unavailable)";
      } else {
        const muted = armed.excludedApps.length
          ? " — Discord muted"
          : "";
        audioSub = `Audio: ${ok} apps mixed${muted}`;
      }
    } else if (!source.isScreen) {
      audioSub = "Audio: this app only";
    }

    const sess = await window.ess.createSession();
    handle = await startScreenShare({
      livekitUrl: sess.livekitUrl,
      token: sess.publisherToken,
      audio: true,
      audioPreset: settings.audioPreset,
      videoMode: settings.videoMode,
      audioTrackOverride: mixer?.track,
    });
    handle.onEnded(() => void stopShare());
    watchViewers(handle);
    window.ess.notifyLive(sess.shareUrl);
    renderStatus("You're live — this window can stay hidden.", false, audioSub);
  } catch (e) {
    mixer?.stop();
    mixer = null;
    handle = null;
    renderStatus(e instanceof Error ? e.message : String(e), true);
  }
}

/** Report viewer count + connection-type breakdown to main for the tray.
 * Viewers self-report their ICE path via the `conn` participant attribute. */
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
window.ess.onAudioRearm(() => void rearmAudio());
window.ess.onMixerSync((diff) => void mixer?.sync(diff));
window.ess.onExcludeSet((list) => mixer?.setExcluded(list));
window.ess.onAudioPreset((name) => void handle?.setAudioPreset(name));
window.ess.onVideoMode((name) => void handle?.setVideoMode(name));

void renderPicker();
