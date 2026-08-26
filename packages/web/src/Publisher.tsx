import { useRef, useState } from "react";
import {
  AUDIO_PRESETS,
  browserSupportsSystemAudio,
  createSession,
  startScreenShare,
  type AudioPresetName,
  type PublishHandle,
} from "@easyscreenshare/core";

type Phase = "idle" | "starting" | "live" | "error";

export default function Publisher() {
  const handleRef = useRef<PublishHandle | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [wantAudio, setWantAudio] = useState(true);
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
      const handle = await startScreenShare({
        livekitUrl: session.livekitUrl,
        token: session.publisherToken,
        audio: wantAudio && audioCapable && !testSource,
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
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
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

  return (
    <div className="publisher">
      <h1>easyscreenshare</h1>
      <p className="tagline">Share your screen. Paste one link. Done.</p>

      {!audioCapable && (
        <p className="banner">
          This browser can't capture system audio — your stream will be silent.
          Use Chrome or Edge for audio (desktop app coming soon).
        </p>
      )}

      {phase !== "live" && (
        <div className="setup">
          <label>
            <input
              type="checkbox"
              checked={wantAudio && audioCapable}
              disabled={!audioCapable}
              onChange={(e) => setWantAudio(e.target.checked)}
            />
            share system audio
          </label>
          <button
            className="primary"
            onClick={start}
            disabled={phase === "starting"}
          >
            {phase === "starting" ? "starting…" : "Start sharing"}
          </button>
          {phase === "error" && <p className="banner error">{error}</p>}
        </div>
      )}

      {phase === "live" && (
        <div className="live">
          <p className="live-indicator">● you are live</p>
          <div className="sharebox">
            <code>{shareUrl}</code>
            <button onClick={copy}>{copied ? "copied ✓" : "copy link"}</button>
          </div>
          {!gotAudio && wantAudio && (
            <p className="banner">
              No system audio was captured — on this OS, Chrome only shares audio
              when you pick a <b>screen</b> (not a window), and on Linux only tab
              audio is available.
            </p>
          )}
          <label className="preset">
            audio quality:{" "}
            <select
              value={preset}
              onChange={(e) => changePreset(e.target.value as AudioPresetName)}
              disabled={!gotAudio}
            >
              {Object.entries(AUDIO_PRESETS).map(([key, p]) => (
                <option key={key} value={key}>
                  {p.label} — {p.hint}
                </option>
              ))}
            </select>
          </label>
          <button className="danger" onClick={stop}>
            Stop sharing
          </button>
        </div>
      )}
    </div>
  );
}
