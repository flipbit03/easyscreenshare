// Picker + publish pipeline renderer. Vanilla DOM — the surface is one grid.
import {
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
    h("p", "sub", "Pick a screen or a window — the link lands in your clipboard."),
  );
  app.append(head);

  const grid = h("div", "grid");
  app.append(grid);

  const sources = await window.ess.listSources();
  if (sources.length === 0) {
    grid.append(h("p", "empty", "No capturable sources found."));
    return;
  }
  const screens = sources.filter((s) => s.isScreen);
  const windows = sources.filter((s) => !s.isScreen);

  const addSection = (label: string, items: SourceInfo[]) => {
    if (!items.length) return;
    const sec = h("div", "section-label", label);
    grid.append(sec);
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
  addSection("Screens", screens);
  addSection("Windows", windows);
}

function renderStatus(text: string, isError = false) {
  app.replaceChildren();
  const box = h("div", "status");
  box.append(h("p", isError ? "err" : undefined, text));
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
    window.ess.chooseSource({ id: source.id, name: source.name });
    const sess = await window.ess.createSession();
    handle = await startScreenShare({
      livekitUrl: sess.livekitUrl,
      token: sess.publisherToken,
      audio: true, // main's handler supplies 'loopback' where the OS can
      audioPreset: "balanced",
      videoMode: "motion",
    });
    handle.onEnded(() => void stopShare());
    window.ess.notifyLive(sess.shareUrl);
    renderStatus("You're live — this window can stay hidden.");
  } catch (e) {
    handle = null;
    renderStatus(
      e instanceof Error ? e.message : String(e),
      true,
    );
  }
}

async function stopShare() {
  const hd = handle;
  handle = null;
  if (hd) await hd.stop().catch(() => {});
  window.ess.notifyStopped();
}

window.ess.onStopRequested(() => void stopShare());

void renderPicker();
