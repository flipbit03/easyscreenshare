import { useEffect, useRef, useState } from "react";
import {
  ConnectionState,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
} from "livekit-client";
import { fetchViewerToken } from "@easyscreenshare/core";

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
  const [quality, setQuality] = useState<QualityChoice>("auto");
  const [viewerCount, setViewerCount] = useState(0);

  useEffect(() => {
    const room = new Room({ adaptiveStream: true });
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
          const el = track.attach();
          el.muted = true; // unmuted only by user click
          document.body.appendChild(el);
        }
      })
      .on(RoomEvent.ParticipantConnected, () => {
        refreshCount();
        if (publisherPresent() && phase === "waiting") setPhase("connecting");
      })
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

  const fullscreen = () => containerRef.current?.requestFullscreen();

  return (
    <div className="viewer" ref={containerRef}>
      <div className="stage">
        {phase === "connecting" && <p className="status">connecting…</p>}
        {phase === "waiting" && <p className="status">waiting for the publisher…</p>}
        {phase === "ended" && <p className="status">stream ended</p>}
        {phase === "error" && <p className="status error">couldn't join: {error}</p>}
        <video
          ref={videoRef}
          playsInline
          autoPlay
          muted
          style={{ display: phase === "live" ? "block" : "none" }}
        />
      </div>
      {phase === "live" && (
        <div className="controls">
          <button onClick={toggleMute}>{muted ? "🔇 unmute" : "🔊 mute"}</button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            disabled={muted}
            onChange={(e) => changeVolume(Number(e.target.value))}
          />
          <select
            value={quality}
            onChange={(e) => changeQuality(e.target.value as QualityChoice)}
          >
            <option value="auto">Auto</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <button onClick={fullscreen}>⛶ fullscreen</button>
          <span className="count">
            {viewerCount} watching
            {roomRef.current?.state === ConnectionState.Connected ? "" : " (reconnecting…)"}
          </span>
        </div>
      )}
    </div>
  );
}
