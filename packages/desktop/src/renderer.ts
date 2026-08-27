// Picker + publish pipeline renderer. Vanilla DOM — the surface is one grid.
import {
  SYSTEM_AUDIO_CONSTRAINTS,
  startScreenShare,
  type PublishHandle,
} from "@easyscreenshare/core";
import type { EssBridge, SourceInfo } from "./preload";
import "./picker.css";

declare global {
  interface Window {
    ess: EssBridge;
  }
}

const app = document.getElementById("app")!;
let handle: PublishHandle | null = null;

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
      "A screen streams system audio (Discord muted by default) — a window streams only that app's audio.",
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

async function startShare(source: SourceInfo, isRetry = false) {
  renderStatus("Starting…");
  try {
    const armed = await window.ess.chooseSource({
      id: source.id,
      name: source.name,
      isScreen: source.isScreen,
    });
    const settings = await window.ess.getSettings();
    const sess = await window.ess.createSession();
    handle = await startScreenShare({
      livekitUrl: sess.livekitUrl,
      token: sess.publisherToken,
      audio: true,
      audioPreset: settings.audioPreset,
      videoMode: settings.videoMode,
    });
    handle.onEnded(() => void stopShare());
    window.ess.notifyLive(sess.shareUrl);
    renderStatus(
      "You're live — this window can stay hidden.",
      false,
      armed.perApp
        ? "Audio: this app only"
        : armed.excludedDiscord
          ? "Audio: system (Discord muted)"
          : "Audio: system",
    );
  } catch (e) {
    handle = null;
    // Per-app device ids are the experimental part (S1): if the capture
    // failed while they were armed, disarm and retry ONCE on plain loopback.
    if (!isRetry && (await window.ess.reportExclusionUnsupported())) {
      return startShare(source, true);
    }
    renderStatus(e instanceof Error ? e.message : String(e), true);
  }
}

/** Main re-armed the audio routing (Discord appeared/vanished, app restarted):
 * capture a fresh audio track and swap it into the live publication. */
async function rearmAudio() {
  if (!handle) return;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: SYSTEM_AUDIO_CONSTRAINTS,
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
  window.ess.notifyStopped();
}

window.ess.onStopRequested(() => void stopShare());
window.ess.onAudioRearm(() => void rearmAudio());
window.ess.onAudioPreset((name) => void handle?.setAudioPreset(name));
window.ess.onVideoMode((name) => void handle?.setVideoMode(name));

void renderPicker();
