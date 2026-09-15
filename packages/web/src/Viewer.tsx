import { useEffect, useRef, useState } from "react";
import {
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
} from "livekit-client";
import {
  PinRequiredError,
  StreamNotFoundError,
  TooManyAttemptsError,
  WrongPinError,
  fetchViewerToken,
} from "@easyscreenshare/core";
import { IconExpand, IconShrink, IconVolume, IconVolumeOff } from "./Icons";

type Phase =
  | "connecting"
  | "gate"
  | "waiting"
  | "live"
  | "ended"
  | "notfound"
  | "error";
const VIEWER_NAME_KEY = "ess:viewer-name";
type QualityChoice = "auto" | "high" | "medium" | "low";

const QUALITY_MAP: Record<Exclude<QualityChoice, "auto">, VideoQuality> = {
  high: VideoQuality.HIGH,
  medium: VideoQuality.MEDIUM,
  low: VideoQuality.LOW,
};

export default function Viewer({ sessionId }: { sessionId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room | null>(null);
  const videoPubRef = useRef<RemoteTrackPublication | null>(null);
  const audioTrackRef = useRef<RemoteTrack | null>(null);

  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(true); // autoplay policy: must start muted
  const [volume, setVolume] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Default to HIGH, not Auto: adaptiveStream picks a layer from the rendered
  // element size, which looks soft even on a fat direct connection. HIGH pins
  // the top layer; the viewer can drop to Auto to save bandwidth.
  const [quality, setQuality] = useState<QualityChoice>("high");
  const [hasAudio, setHasAudio] = useState(false);
  /** Publisher-side mute ("Mute audio" on the sharer's end): the stream
   * carries silence, so the viewer's own unmute plays nothing — say so, or
   * the unmute button looks broken (field-hit). */
  const [hostMuted, setHostMuted] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [viewerName, setViewerName] = useState(
    () => localStorage.getItem(VIEWER_NAME_KEY) ?? "",
  );
  const [pinInput, setPinInput] = useState("");
  const [gateError, setGateError] = useState("");
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connReported = useRef(false);
  const joinBusy = useRef(false);
  const joinRef = useRef<(pin?: string) => Promise<void>>(async () => {});

  useEffect(() => {
    const room = new Room({ adaptiveStream: true });
    (globalThis as unknown as { __essRoom?: Room }).__essRoom = room; // e2e/debug handle
    roomRef.current = room;

    // Measure our own ICE path and report it to the publisher via attributes.
    const reportConnection = async () => {
      if (connReported.current) return;
      try {
        for (const p of room.remoteParticipants.values()) {
          for (const pub of p.trackPublications.values()) {
            const recv = (pub.track as { receiver?: RTCRtpReceiver } | undefined)
              ?.receiver;
            if (!recv) continue;
            const stats = await recv.getStats();
            for (const s of stats.values()) {
              if (s.type === "candidate-pair" && s.state === "succeeded" && s.nominated) {
                const lc = stats.get(s.localCandidateId) as
                  | { candidateType?: string; protocol?: string; relayProtocol?: string }
                  | undefined;
                if (!lc) continue;
                const conn =
                  lc.candidateType === "relay"
                    ? `relay · ${lc.relayProtocol ?? "?"}`
                    : `direct · ${lc.protocol ?? "?"}`;
                await room.localParticipant.setAttributes({ conn });
                connReported.current = true;
                return;
              }
            }
          }
        }
      } catch {
        // best-effort telemetry — never break playback over it
      }
    };

    const publisherPresent = () =>
      [...room.remoteParticipants.values()].some((p) => p.identity === "publisher");

    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub) => {
        if (track.kind === Track.Kind.Video) {
          videoPubRef.current = pub;
          if (videoRef.current) track.attach(videoRef.current);
          pub.setVideoQuality(VideoQuality.HIGH); // match the "high" default
          setPhase("live");
          setTimeout(() => void reportConnection(), 3000);
        } else if (track.kind === Track.Kind.Audio) {
          audioTrackRef.current = track;
          // Muted playback until the user unmutes. Two traps here:
          // 1) an unmuted play() without a user gesture is rejected by
          //    autoplay policy (element stays paused forever), and
          // 2) LiveKit's attach() UNMUTES the element it attaches to — so
          //    muted must be re-asserted AFTER attach, or a viewer who has
          //    already interacted (e.g. typed the PIN) hears audio at once.
          const el = new Audio();
          el.muted = true;
          track.attach(el);
          el.muted = true; // attach() flips it — re-assert
          document.body.appendChild(el);
          setHasAudio(true);
          setHostMuted(pub.isMuted); // may join while the host is muted
        }
      })
      .on(RoomEvent.TrackMuted, (pub) => {
        if (pub.kind === Track.Kind.Audio) setHostMuted(true);
      })
      .on(RoomEvent.TrackUnmuted, (pub) => {
        if (pub.kind === Track.Kind.Audio) setHostMuted(false);
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        if (p.identity === "publisher") setPhase("ended");
      })
      .on(RoomEvent.Disconnected, () => {
        setPhase((prev) => (prev === "live" ? "ended" : prev));
      });

    const join = async (pin?: string) => {
      if (joinBusy.current) return;
      joinBusy.current = true;
      setGateError("");
      if (pin !== undefined) setPhase("connecting"); // gate → feedback now
      try {
        const name = localStorage.getItem(VIEWER_NAME_KEY) ?? undefined;
        const { token, livekitUrl } = await fetchViewerToken(sessionId, {
          pin,
          name,
        });
        await room.connect(livekitUrl, token);
        if (!publisherPresent()) setPhase("waiting");
        else setPhase((prev) => (prev === "gate" ? "connecting" : prev));
      } catch (e) {
        if (e instanceof PinRequiredError) {
          setPhase("gate");
        } else if (e instanceof WrongPinError) {
          setPhase("gate");
          if (pin !== undefined) setGateError("wrong PIN");
        } else if (e instanceof TooManyAttemptsError) {
          setPhase("gate");
          setGateError("too many tries — wait a minute");
        } else if (e instanceof StreamNotFoundError) {
          setPhase("notfound");
        } else {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      } finally {
        joinBusy.current = false;
      }
    };
    joinRef.current = join;
    void join();

    return () => {
      void room.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (!gateError) return;
    const t = setTimeout(() => setGateError(""), 4000);
    return () => clearTimeout(t);
  }, [gateError]);

  const submitGate = () => {
    const n = viewerName.trim();
    if (n) localStorage.setItem(VIEWER_NAME_KEY, n);
    else localStorage.removeItem(VIEWER_NAME_KEY);
    void joinRef.current(pinInput.trim());
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    for (const el of audioTrackRef.current?.attachedElements ?? []) {
      el.muted = next;
      (el as HTMLAudioElement).volume = volume;
      // The unmute click IS a user gesture — (re)start playback with it in
      // case the initial autoplay was rejected.
      if (!next) void (el as HTMLAudioElement).play().catch(() => {});
    }
  };

  const changeVolume = (v: number) => {
    setVolume(v);
    for (const el of audioTrackRef.current?.attachedElements ?? []) {
      (el as HTMLAudioElement).volume = v;
    }
  };

  const changeQuality = (q: QualityChoice) => {
    setQuality(q);
    if (q !== "auto") videoPubRef.current?.setVideoQuality(QUALITY_MAP[q]);
    else videoPubRef.current?.setVideoQuality(VideoQuality.HIGH);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void containerRef.current?.requestFullscreen();
  };

  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Floating controls: appear on pointer activity, auto-hide after idle so
  // the full screen is visible; hovering the bar itself keeps it pinned.
  const mutedWithAudio = muted && hasAudio;
  const pokeControls = () => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 2500);
  };
  useEffect(() => {
    if (phase === "live") pokeControls(); // show briefly on stream start
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);
  const showControls = controlsVisible || phase !== "live";

  return (
    <div className="viewer" ref={containerRef}>
      <div
        className={showControls ? "stage" : "stage idle"}
        onPointerMove={pokeControls}
        onPointerDown={pokeControls}
      >
        {phase !== "live" && (
          <div className="stage-status">
            <span className="wordmark dim">
              easyscreenshare<span className="wordmark-dot" aria-hidden="true" />
            </span>
            {phase === "connecting" && <p>connecting…</p>}
            {phase === "gate" && (
              <div className="gate">
                <p className="gate-title">This stream is closed</p>
                <p className="gate-sub">ask the host for the 4-digit PIN</p>
                <label className="gate-field">
                  <span className="gate-prefix">name</span>
                  <input
                    type="text"
                    placeholder="optional"
                    maxLength={64}
                    value={viewerName}
                    onChange={(e) => setViewerName(e.target.value)}
                  />
                </label>
                <label className="gate-field">
                  <span className="gate-prefix">PIN</span>
                  <input
                    className="gate-pin"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={4}
                    value={pinInput}
                    onChange={(e) =>
                      setPinInput(e.target.value.replace(/[^0-9]/g, ""))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitGate();
                    }}
                  />
                </label>
                <p className="gate-error" aria-live="polite">
                  {gateError || " "}
                </p>
                <button
                  className="gate-join"
                  onClick={submitGate}
                  disabled={pinInput.length < 4}
                >
                  Watch
                </button>
              </div>
            )}
            {phase === "waiting" && <p>waiting for the stream to start…</p>}
            {phase === "ended" && <p>stream ended</p>}
            {phase === "notfound" && (
              <>
                <p>This stream doesn't exist or has ended.</p>
                <a className="home-link" href="/">
                  Share your own screen →
                </a>
              </>
            )}
            {phase === "error" && <p className="err">couldn't join: {error}</p>}
          </div>
        )}
        <video
          ref={videoRef}
          playsInline
          autoPlay
          muted
          style={{ display: phase === "live" ? "block" : "none" }}
        />
        {phase === "live" && hostMuted && hasAudio && (
          <div className="host-muted-badge">host muted the audio</div>
        )}
        {phase === "live" && (
          <div
            className={showControls ? "controls-float" : "controls-float hidden"}
            onPointerMove={(e) => e.stopPropagation()}
            onPointerEnter={() => {
              if (hideTimer.current) clearTimeout(hideTimer.current);
              setControlsVisible(true);
            }}
            onPointerLeave={pokeControls}
          >
            <button
              className={mutedWithAudio ? "ctl unmute-cta" : "ctl"}
              onClick={toggleMute}
              disabled={!hasAudio}
              title={
                !hasAudio
                  ? "This stream has no audio"
                  : hostMuted
                    ? "The host muted the stream audio"
                    : muted
                      ? "Unmute"
                      : "Mute"
              }
            >
              {muted || !hasAudio ? <IconVolumeOff /> : <IconVolume />}
            </button>
            <input
              className="vol"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              disabled={!hasAudio}
              onChange={(e) => changeVolume(Number(e.target.value))}
              aria-label="Volume"
            />
            <select
              className="quality"
              value={quality}
              onChange={(e) => changeQuality(e.target.value as QualityChoice)}
              aria-label="Video quality"
            >
              <option value="auto">Auto</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <button className="ctl" onClick={toggleFullscreen} title="Fullscreen">
              {isFullscreen ? <IconShrink /> : <IconExpand />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
