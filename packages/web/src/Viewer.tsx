import { useEffect, useRef, useState } from "react";
import {
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
} from "livekit-client";
import { fetchViewerToken } from "@easyscreenshare/core";
import {
  IconExpand,
  IconEye,
  IconShrink,
  IconVolume,
  IconVolumeOff,
} from "./Icons";

type Phase = "connecting" | "waiting" | "live" | "ended" | "error";
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
  const [quality, setQuality] = useState<QualityChoice>("auto");
  const [viewerCount, setViewerCount] = useState(0);
  const [hasAudio, setHasAudio] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const room = new Room({ adaptiveStream: true });
    (globalThis as unknown as { __essRoom?: Room }).__essRoom = room; // e2e/debug handle
    roomRef.current = room;

    const refreshCount = () => {
      let n = 0;
      for (const p of room.remoteParticipants.values()) {
        if (p.identity.startsWith("viewer-")) n++;
      }
      setViewerCount(n + 1); // include ourselves
    };

    const publisherPresent = () =>
      [...room.remoteParticipants.values()].some((p) => p.identity === "publisher");

    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub) => {
        if (track.kind === Track.Kind.Video) {
          videoPubRef.current = pub;
          if (videoRef.current) track.attach(videoRef.current);
          setPhase("live");
        } else if (track.kind === Track.Kind.Audio) {
          audioTrackRef.current = track;
          // Mute BEFORE attach: attach() calls play(), and an unmuted play()
          // without a user gesture is rejected by autoplay policy — leaving
          // the element paused forever. Muted playback is always allowed.
          const el = new Audio();
          el.muted = true;
          track.attach(el);
          document.body.appendChild(el);
          setHasAudio(true);
        }
      })
      .on(RoomEvent.ParticipantConnected, refreshCount)
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        refreshCount();
        if (p.identity === "publisher") setPhase("ended");
      })
      .on(RoomEvent.Disconnected, () => {
        setPhase((prev) => (prev === "live" ? "ended" : prev));
      });

    (async () => {
      try {
        const { token, livekitUrl } = await fetchViewerToken(sessionId);
        await room.connect(livekitUrl, token);
        refreshCount();
        if (!publisherPresent()) setPhase("waiting");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();

    return () => {
      void room.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

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

  // Floating controls: appear on pointer activity, auto-hide after idle —
  // but NEVER hide while muted audio exists (the unmute control must stay
  // reachable) or while hovering the bar itself.
  const mutedWithAudio = muted && hasAudio;
  const pokeControls = () => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 2500);
  };
  useEffect(() => {
    if (mutedWithAudio) {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setControlsVisible(true);
    }
  }, [mutedWithAudio]);
  const showControls = controlsVisible || mutedWithAudio || phase !== "live";

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
            {phase === "waiting" && <p>waiting for the stream to start…</p>}
            {phase === "ended" && <p>stream ended</p>}
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
              title={!hasAudio ? "This stream has no audio" : muted ? "Unmute" : "Mute"}
            >
              {muted || !hasAudio ? <IconVolumeOff /> : <IconVolume />}
              {mutedWithAudio && <span className="unmute-label">Unmute</span>}
            </button>
            <input
              className="vol"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              disabled={muted || !hasAudio}
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
            <span className="count">
              <IconEye />
              {viewerCount}
            </span>
            <button className="ctl" onClick={toggleFullscreen} title="Fullscreen">
              {isFullscreen ? <IconShrink /> : <IconExpand />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
