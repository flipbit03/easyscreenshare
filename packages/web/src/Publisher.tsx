import { useRef, useState } from "react";
import {
  AUDIO_PRESETS,
  browserSupportsSystemAudio,
  createSession,
  startScreenShare,
  type AudioPresetName,
  type PublishHandle,
} from "@easyscreenshare/core";
import { IconCheck, IconCopy, IconScreen } from "./Icons";

type Phase = "idle" | "starting" | "live" | "error";

export default function Publisher() {
  const handleRef = useRef<PublishHandle | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [preset, setPreset] = useState<AudioPresetName>("balanced");
  const [gotAudio, setGotAudio] = useState(true);

  const audioCapable = browserSupportsSystemAudio();

  const start = async () => {
    setPhase("starting");
    setError("");
    try {
      const session = await createSession();
      const testSource =
        new URLSearchParams(location.search).get("testsource") === "canvas"
          ? ("canvas" as const)
          : undefined;
      // Audio is always requested when the browser can deliver it — Chrome's
      // own picker checkbox is the single place the user decides.
      const handle = await startScreenShare({
        livekitUrl: session.livekitUrl,
        token: session.publisherToken,
        audio: audioCapable && !testSource,
        audioPreset: preset,
        testSource,
      });
      handleRef.current = handle;
      handle.onEnded(() => void stop());
      setGotAudio(handle.hasAudio);
      setShareUrl(session.shareUrl);
      try {
        await navigator.clipboard.writeText(session.shareUrl);
        setCopied(true);
      } catch {
        setCopied(false); // clipboard needs a secure context; show the link anyway
      }
      setPhase("live");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/NotAllowed|Permission/i.test(msg)) {
        setPhase("idle"); // user cancelled the picker — not an error
      } else {
        setError(msg);
        setPhase("error");
      }
    }
  };

  const stop = async () => {
    await handleRef.current?.stop();
    handleRef.current = null;
    setPhase("idle");
    setShareUrl("");
    setCopied(false);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
  };

  const changePreset = (p: AudioPresetName) => {
    setPreset(p);
    void handleRef.current?.setAudioPreset(p);
  };

  const live = phase === "live";

  return (
    <div className="publisher">
      <header className="topbar">
        <span className="wordmark">
          easyscreenshare<span className="wordmark-dot" aria-hidden="true" />
        </span>
      </header>

      {!live && (
        <main className="hero">
          <h1>
            Your screen.
            <br />
            One link.
          </h1>
          <p className="sub">
            Hit share, send the link — friends watch live in any browser.
            No installs, no accounts, quality up to native resolution.
          </p>

          <button
            className="cta"
            onClick={start}
            disabled={phase === "starting"}
          >
            <IconScreen width={20} height={20} />
            {phase === "starting" ? "Starting…" : "Share my screen"}
          </button>

          {!audioCapable && (
            <p className="note warn">
              This browser can't capture system audio — the stream will be
              video-only. Chrome or Edge can share sound.
            </p>
          )}
          {phase === "error" && <p className="note error">{error}</p>}

          <ol className="steps">
            <li>
              <b>Pick what to share.</b> A screen shares its audio too — check
              “also share system audio” in the dialog.
            </li>
            <li>
              <b>The link lands in your clipboard.</b> Paste it anywhere —
              Discord still does text just fine.
            </li>
            <li>
              <b>They're watching.</b> Any browser, no install, adaptive
              quality up to source resolution.
            </li>
          </ol>
        </main>
      )}

      {live && (
        <main className="live-panel">
          <div className="live-head">
            <span className="live-badge">
              <span className="live-dot" aria-hidden="true" />
              LIVE
            </span>
            <span className="live-hint">
              {copied ? "Link copied — paste it to your friends" : "Send this link to your friends"}
            </span>
          </div>

          <div className="sharebox">
            <code>{shareUrl}</code>
            <button className="copy-btn" onClick={copy}>
              {copied ? <IconCheck /> : <IconCopy />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          {!gotAudio && audioCapable && (
            <p className="note warn">
              No system audio came through. Share your <b>entire screen</b> and
              enable <b>“Also share system audio”</b> in Chrome's dialog, then
              start again.
            </p>
          )}

          {gotAudio && (
            <div className="preset-row">
              <span className="preset-label">Audio quality</span>
              <div className="segmented" role="radiogroup" aria-label="Audio quality">
                {(Object.keys(AUDIO_PRESETS) as AudioPresetName[]).map((key) => (
                  <button
                    key={key}
                    role="radio"
                    aria-checked={preset === key}
                    className={preset === key ? "seg on" : "seg"}
                    onClick={() => changePreset(key)}
                    title={AUDIO_PRESETS[key].hint}
                  >
                    {AUDIO_PRESETS[key].label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <button className="stop-btn" onClick={stop}>
            Stop sharing
          </button>
        </main>
      )}

      <footer className="foot">
        <a href="https://github.com/flipbit03/easyscreenshare">open source</a>
        <span aria-hidden="true">·</span>
        <span>made in Brazil, where Discord can't share screens anymore</span>
      </footer>
    </div>
  );
}
