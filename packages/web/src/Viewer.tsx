import { useEffect, useRef, useState } from "react";
import {
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
} from "livekit-client";
import { StreamNotFoundError, fetchViewerToken } from "@easyscreenshare/core";
import { IconExpand, IconShrink, IconVolume, IconVolumeOff } from "./Icons";

type Phase = "connecting" | "waiting" | "live" | "ended" | "notfound" | "error";
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
  const [hasAudio, setHasAudio] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connReported = useRef(false);

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
          setPhase("live");
          setTimeout(() => void reportConnection(), 3000);
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
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        if (p.identity === "publisher") setPhase("ended");
      })
      .on(RoomEvent.Disconnected, () => {
        setPhase((prev) => (prev === "live" ? "ended" : prev));
      });

    (async () => {
      try {
        const { token, livekitUrl } = await fetchViewerToken(sessionId);
        await room.connect(livekitUrl, token);
        if (!publisherPresent()) setPhase("waiting");
      } catch (e) {
        if (e instanceof StreamNotFoundError) {
          setPhase("notfound");
        } else {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
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
