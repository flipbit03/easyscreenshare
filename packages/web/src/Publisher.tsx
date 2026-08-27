import { useEffect, useRef, useState } from "react";
import { RoomEvent } from "livekit-client";
import {
  AUDIO_PRESETS,
  NameTakenError,
  VIDEO_MODES,
  browserSupportsSystemAudio,
  checkName,
  createSession,
  startScreenShare,
  type AudioPresetName,
  type PublishHandle,
  type VideoModeName,
} from "@easyscreenshare/core";

type NameStatus = "idle" | "checking" | "available" | "taken" | "invalid";
const NAME_KEY = "ess:name";
import { IconCheck, IconCopy, IconEye, IconScreen } from "./Icons";

type Phase = "idle" | "starting" | "live" | "error";

interface ViewerStats {
  count: number;
  conns: Array<[string, number]>; // connection type -> count, e.g. ["direct · udp", 3]
}

export default function Publisher() {
  const handleRef = useRef<PublishHandle | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [preset, setPreset] = useState<AudioPresetName>("balanced");
  const [videoMode, setVideoMode] = useState<VideoModeName>("motion");
  const [gotAudio, setGotAudio] = useState(true);
  const [viewers, setViewers] = useState<ViewerStats>({ count: 0, conns: [] });
  const [name, setName] = useState(
    () => localStorage.getItem(NAME_KEY) ?? "",
  );
  const [nameStatus, setNameStatus] = useState<NameStatus>("idle");

  const audioCapable = browserSupportsSystemAudio();

  // Live availability check (debounced) + remember the name for next time.
  useEffect(() => {
    const n = name.trim();
    if (n) localStorage.setItem(NAME_KEY, n);
    else localStorage.removeItem(NAME_KEY);
    if (!n) {
      setNameStatus("idle");
      return;
    }
    setNameStatus("checking");
    const t = setTimeout(async () => {
      const r = await checkName(n);
      setNameStatus(!r.valid ? "invalid" : r.available ? "available" : "taken");
    }, 350);
    return () => clearTimeout(t);
  }, [name]);

  useEffect(() => {
    if (phase !== "live") return;
    const room = handleRef.current?.room;
    if (!room) return;
    const refresh = () => {
      const groups = new Map<string, number>();
      let count = 0;
      for (const p of room.remoteParticipants.values()) {
        if (!p.identity.startsWith("viewer-")) continue;
        count++;
        const key = p.attributes?.conn ?? "connecting…";
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      setViewers({ count, conns: [...groups.entries()] });
    };
    refresh();
    room
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ParticipantAttributesChanged, refresh);
    return () => {
      room
        .off(RoomEvent.ParticipantConnected, refresh)
        .off(RoomEvent.ParticipantDisconnected, refresh)
        .off(RoomEvent.ParticipantAttributesChanged, refresh);
    };
  }, [phase]);

  const start = async () => {
    setPhase("starting");
    setError("");
    try {
      const session = await createSession(name.trim() || undefined);
      const testSource =
        new URLSearchParams(location.search).get("testsource") === "canvas"
          ? ("canvas" as const)
          : undefined;
      // Audio is always requested when the browser can deliver it — Chrome's
      // own picker checkbox is the single place the user decides.
      const handle = await startScreenShare({
        livekitUrl: session.livekitUrl,
        token: session.publisherToken,
        audio: audioCapable,
        audioPreset: preset,
        videoMode,
        heartbeat: {
          sessionId: session.sessionId,
          secret: session.sessionSecret,
        },
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
      if (e instanceof NameTakenError) {
        setNameStatus("taken"); // lost a race between check and claim
        setPhase("idle");
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (/NotAllowed|Permission/i.test(msg)) {
        setPhase("idle"); // user cancelled the picker — not an error
      } else {
        setError(msg);
        setPhase("error");
      }
    }
  };

  /** Re-pick the shared surface without dropping the stream or link. */
  const changeSource = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60 } },
      } as DisplayMediaStreamOptions);
      const track = stream.getVideoTracks()[0];
      if (track) await handleRef.current?.replaceVideoTrack(track);
    } catch {
      // user cancelled the picker — keep sharing the current surface
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

  const changeVideoMode = (m: VideoModeName) => {
    setVideoMode(m);
    void handleRef.current?.setVideoMode(m);
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

          <div className="name-row">
            <label className={`name-field name-${nameStatus}`}>
              <span className="name-prefix">/s/</span>
              <input
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="custom name (optional)"
                value={name}
                maxLength={32}
                onChange={(e) =>
                  setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))
                }
              />
              {name.trim() && (
                <span className={`name-badge name-badge-${nameStatus}`}>
                  {nameStatus === "checking" && "…"}
                  {nameStatus === "available" && "✓ available"}
                  {nameStatus === "taken" && "✗ taken"}
                  {nameStatus === "invalid" && "3–32: a–z 0–9 - _"}
                </span>
              )}
            </label>
          </div>

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
              <b>The link lands in your clipboard.</b> Paste it anywhere.
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
            {gotAudio && (
              <span className="audio-chip">
                <span className="audio-chip-dot" aria-hidden="true" />
                system audio on
              </span>
            )}
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

          <div className="viewers-line">
            <IconEye />
            {viewers.count === 0 ? (
              <span>no one watching yet</span>
            ) : (
              <>
                <span>
                  {viewers.count} watching
                </span>
                {viewers.conns.map(([type, n]) => (
                  <span key={type} className="conn-chip">
                    {n}× {type}
                  </span>
                ))}
              </>
            )}
          </div>

          <div className="preset-row">
            <span className="preset-label">Video</span>
            <div className="segmented" role="radiogroup" aria-label="Video mode">
              {(Object.keys(VIDEO_MODES) as VideoModeName[]).map((key) => (
                <button
                  key={key}
                  role="radio"
                  aria-checked={videoMode === key}
                  className={videoMode === key ? "seg on" : "seg"}
                  onClick={() => changeVideoMode(key)}
                  title={VIDEO_MODES[key].hint}
                >
                  {VIDEO_MODES[key].label}
                </button>
              ))}
            </div>
          </div>

          {gotAudio && (
            <div className="preset-row">
              <span className="preset-label">Audio</span>
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

          <div className="live-actions">
            <button className="ghost-btn" onClick={changeSource}>
              Change what you're sharing
            </button>
            <button className="stop-btn" onClick={stop}>
              Stop sharing
            </button>
          </div>
        </main>
      )}

      <footer className="foot">
        <a href="https://github.com/flipbit03/easyscreenshare">open source</a>
        <span aria-hidden="true">·</span>
        <span>MIT licensed</span>
      </footer>
    </div>
  );
}
