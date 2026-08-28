import { useEffect, useRef, useState } from "react";
import { RoomEvent } from "livekit-client";
import {
  AUDIO_PRESETS,
  NameTakenError,
  VIDEO_MODES,
  browserSupportsSystemAudio,
  checkName,
  createSession,
  kickViewer,
  startScreenShare,
  type AudioPresetName,
  type PublishHandle,
  type VideoModeName,
} from "@easyscreenshare/core";
import { IconCheck, IconCopy, IconEye, IconScreen } from "./Icons";

type Phase = "idle" | "starting" | "live" | "error";
type NameStatus = "idle" | "checking" | "available" | "taken" | "invalid";
const NAME_KEY = "ess:name";
const PUBLIC_KEY = "ess:public";

interface ViewerRow {
  identity: string;
  name: string;
  conn: string;
  joinedAt: number;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""} ago`;
}

export default function Publisher() {
  const handleRef = useRef<PublishHandle | null>(null);
  const sessionRef = useRef<{ id: string; secret: string } | null>(null);
  const joinedAtRef = useRef<Map<string, number>>(new Map());
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [pin, setPin] = useState<string | null>(null);
  const [copied, setCopied] = useState<"" | "link" | "both">("");
  const [notice, setNotice] = useState("");
  const [preset, setPreset] = useState<AudioPresetName>("balanced");
  const [videoMode, setVideoMode] = useState<VideoModeName>("motion");
  const [gotAudio, setGotAudio] = useState(true);
  const [viewers, setViewers] = useState<ViewerRow[]>([]);
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [nameStatus, setNameStatus] = useState<NameStatus>("idle");
  const [isPublic, setIsPublic] = useState(
    () => localStorage.getItem(PUBLIC_KEY) === "1",
  );

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
    localStorage.setItem(PUBLIC_KEY, isPublic ? "1" : "0");
  }, [isPublic]);

  // Viewers list: names come from tokens, conn self-reported via attributes.
  useEffect(() => {
    if (phase !== "live") return;
    const room = handleRef.current?.room;
    if (!room) return;
    const refresh = () => {
      const rows: ViewerRow[] = [];
      for (const p of room.remoteParticipants.values()) {
        if (!p.identity.startsWith("viewer-")) continue;
        if (!joinedAtRef.current.has(p.identity)) {
          joinedAtRef.current.set(
            p.identity,
            p.joinedAt ? p.joinedAt.getTime() : Date.now(),
          );
        }
        rows.push({
          identity: p.identity,
          name: p.name || "Someone",
          conn: p.attributes?.conn ?? "connecting…",
          joinedAt: joinedAtRef.current.get(p.identity)!,
        });
      }
      rows.sort((a, b) => a.joinedAt - b.joinedAt);
      setViewers(rows);
    };
    refresh();
    const tick = setInterval(refresh, 30_000); // keep "ago" labels fresh
    room
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ParticipantAttributesChanged, refresh);
    return () => {
      clearInterval(tick);
      room
        .off(RoomEvent.ParticipantConnected, refresh)
        .off(RoomEvent.ParticipantDisconnected, refresh)
        .off(RoomEvent.ParticipantAttributesChanged, refresh);
    };
  }, [phase]);

  const copyText = async (kind: "link" | "both") => {
    const text =
      kind === "both" && pin ? `${shareUrl} · PIN: ${pin}` : shareUrl;
    await navigator.clipboard.writeText(text);
    setCopied(kind);
  };

  const start = async () => {
    setPhase("starting");
    setError("");
    setNotice("");
    try {
      const session = await createSession({
        name: name.trim() || undefined,
        public: isPublic,
      });
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
      sessionRef.current = { id: session.sessionId, secret: session.sessionSecret };
      joinedAtRef.current.clear();
      handle.onEnded(() => void stop());
      setGotAudio(handle.hasAudio);
      setShareUrl(session.shareUrl);
      setPin(session.pin);
      try {
        const text = session.pin
          ? `${session.shareUrl} · PIN: ${session.pin}`
          : session.shareUrl;
        await navigator.clipboard.writeText(text);
        setCopied(session.pin ? "both" : "link");
      } catch {
        setCopied(""); // clipboard needs a secure context; show the link anyway
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

  const kick = async (v: ViewerRow) => {
    const s = sessionRef.current;
    if (!s) return;
    try {
      const r = await kickViewer(s.id, s.secret, v.identity);
      if (r.pin) {
        setPin(r.pin);
        setCopied("");
        setNotice(
          r.disconnected
            ? `Kicked ${v.name} — new PIN: ${r.pin}`
            : `PIN rotated to ${r.pin} — couldn't drop ${v.name}'s connection`,
        );
      } else {
        setNotice(
          r.disconnected ? `Kicked ${v.name}` : `Couldn't drop ${v.name}'s connection`,
        );
      }
    } catch (e) {
      setNotice(`Kick failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const stop = async () => {
    await handleRef.current?.stop();
    handleRef.current = null;
    sessionRef.current = null;
    setPhase("idle");
    setShareUrl("");
    setPin(null);
    setCopied("");
    setNotice("");
    setViewers([]);
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
                  {nameStatus === "checking" && "checking…"}
                  {nameStatus === "available" && "free ✓"}
                  {nameStatus === "taken" && "taken"}
                  {nameStatus === "invalid" &&
                    (name.trim().length < 3 ? "too short" : "invalid")}
                </span>
              )}
            </label>
          </div>

          <label className="public-row">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            Public stream — anyone with the link can watch (no PIN)
          </label>

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
              <b>The link lands in your clipboard.</b> Closed streams get a
              4-digit PIN — say it on your call.
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
            {pin && (
              <span className="pin-chip" title="Say this on your call — viewers need it">
                PIN: <b>{pin}</b>
              </span>
            )}
            {gotAudio && (
              <span className="audio-chip">
                <span className="audio-chip-dot" aria-hidden="true" />
                system audio on
              </span>
            )}
          </div>

          <div className="sharebox">
            <code>{shareUrl}</code>
            <button className="copy-btn" onClick={() => void copyText("link")}>
              {copied === "link" ? <IconCheck /> : <IconCopy />}
              Link
            </button>
            {pin && (
              <button className="copy-btn" onClick={() => void copyText("both")}>
                {copied === "both" ? <IconCheck /> : <IconCopy />}
                Link + PIN
              </button>
            )}
          </div>

          {notice && <p className="note warn">{notice}</p>}

          {!gotAudio && audioCapable && (
            <p className="note warn">
              No system audio came through. Share your <b>entire screen</b> and
              enable <b>“Also share system audio”</b> in Chrome's dialog, then
              start again.
            </p>
          )}

          <div className="viewers-line">
            <IconEye />
            {viewers.length === 0 ? (
              <span>no one watching yet</span>
            ) : (
              <span>{viewers.length} watching</span>
            )}
          </div>
          {viewers.length > 0 && (
            <ul className="viewer-list">
              {viewers.map((v) => (
                <li key={v.identity} className="viewer-row">
                  <span className="viewer-name">{v.name}</span>
                  <span className="viewer-meta">
                    joined {ago(v.joinedAt)} · {v.conn}
                  </span>
                  <button className="kick-btn" onClick={() => void kick(v)}>
                    Kick + New PIN
                  </button>
                </li>
              ))}
            </ul>
          )}

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
