// The shared publish pipeline: capture → constraints → simulcast → LiveKit.
// Runs identically in the browser publisher page and the Electron renderer.
//
// Carries the guards from docs/research/04-audio-capture.md:
//  - APM off (echoCancellation/noiseSuppression/autoGainControl explicitly false)
//    — getDisplayMedia turns voice processing ON by default and it mangles music.
//  - restrictOwnAudio — never capture our own app's audio (feedback loop 1).
//  - forceStereo + dtx:false — LiveKit's stereo auto-detection is unreliable in
//    Chromium; without this Opus silently downmixes to mono.
//  - contentHint + degradationPreference — under bandwidth pressure, keep text
//    crisp and drop framerate instead (research 01 §2: don't trust the hint alone).
import {
  Room,
  ScreenSharePresets,
  Track,
  TrackEvent,
  type LocalTrackPublication,
} from "livekit-client";

import { startHeartbeat } from "./api";

export type AudioPresetName = "voice" | "balanced" | "music";

export const AUDIO_PRESETS: Record<
  AudioPresetName,
  { maxBitrate: number; label: string; hint: string }
> = {
  voice: { maxBitrate: 64_000, label: "Voice", hint: "talking, screencasts" },
  balanced: { maxBitrate: 128_000, label: "Balanced", hint: "general use" },
  music: { maxBitrate: 256_000, label: "Music", hint: "Spotify, games, film" },
};

export type VideoModeName = "motion" | "text";

export const VIDEO_MODES: Record<VideoModeName, { label: string; hint: string }> = {
  motion: { label: "Smooth motion", hint: "games, video — favors 60 fps" },
  text: { label: "Sharp text", hint: "code, docs — favors resolution" },
};

/** APM-off system-audio constraints (research 04): voice processing OFF or
 * music gets mangled; stereo; own-app audio excluded. Shared between initial
 * capture and re-captures. */
export const SYSTEM_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
  sampleRate: 48000,
  restrictOwnAudio: true,
} as MediaTrackConstraints;

export interface StartOptions {
  livekitUrl: string;
  token: string;
  audio: boolean;
  audioPreset: AudioPresetName;
  videoMode?: VideoModeName;
  /** When set, this track is published as the stream audio and getDisplayMedia
   * is asked for video only (used by the desktop app's per-app audio mixer). */
  audioTrackOverride?: MediaStreamTrack;
  /** Keep the session marked live server-side for its whole duration. */
  heartbeat?: { sessionId: string; secret: string; baseUrl?: string };
  /** Test/CI hook: publish an animated 1080p60 canvas instead of capturing —
   * needs no permissions/picker, so automated e2e can run fully headless. */
  testSource?: "canvas";
}

function createCanvasTestStream(): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  // Synthetic test tone so audio paths (publish, mute/unmute, presets,
  // delivery stats) are exercisable in headless e2e. 440 Hz, gently pulsed.
  const ac = new AudioContext({ sampleRate: 48000 });
  void ac.resume(); // caller's click is the required gesture
  const osc = ac.createOscillator();
  osc.frequency.value = 440;
  const gain = ac.createGain();
  gain.gain.value = 0.15;
  const lfo = ac.createOscillator();
  lfo.frequency.value = 2;
  const lfoGain = ac.createGain();
  lfoGain.gain.value = 0.1;
  lfo.connect(lfoGain).connect(gain.gain);
  const dest = ac.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  lfo.start();
  const ctx = canvas.getContext("2d")!;
  let frame = 0;
  const draw = () => {
    frame++;
    ctx.fillStyle = "#101014";
    ctx.fillRect(0, 0, 1920, 1080);
    ctx.fillStyle = "#3557d6";
    ctx.fillRect((frame * 7) % 1800, 200, 120, 680);
    ctx.fillStyle = "#fff";
    ctx.font = "48px monospace";
    ctx.fillText(`test source — frame ${frame}`, 60, 100);
    requestAnimationFrame(draw);
  };
  draw();
  const stream = canvas.captureStream(60);
  stream.addTrack(dest.stream.getAudioTracks()[0]);
  return stream;
}

export interface PublishHandle {
  room: Room;
  /** False when the browser/OS could not provide system audio. */
  hasAudio: boolean;
  setAudioPreset(name: AudioPresetName): Promise<void>;
  setVideoMode(name: VideoModeName): Promise<void>;
  /** Temporarily silence the stream audio (and back). Track-level mute: the
   * transport stays up, so resume is instant and viewers never reconnect. */
  setAudioMuted(muted: boolean): Promise<void>;
  /** Swap the live audio track without renegotiation (viewers hear a blip
   * at most). Used to re-arm capture when audio exclusions change. */
  replaceAudioTrack(track: MediaStreamTrack): Promise<void>;
  /** Swap the live VIDEO track — lets the sharer change the shared source
   * (screen ↔ window) without dropping the stream or changing the link. */
  replaceVideoTrack(track: MediaStreamTrack): Promise<void>;
  /** Fired when capture ends outside our UI (browser's own "stop sharing"). */
  onEnded(cb: () => void): void;
  stop(): Promise<void>;
}

export async function startScreenShare(opts: StartOptions): Promise<PublishHandle> {
  // Capture at NATIVE resolution — getDisplayMedia constraints are hints only;
  // real ceilings are enforced at the encoder via simulcast layers (research 02 §3).
  const stream = opts.testSource === "canvas"
    ? createCanvasTestStream()
    : await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 60 } },
    audio: opts.audio && !opts.audioTrackOverride ? SYSTEM_AUDIO_CONSTRAINTS : false,
    // Non-standard-but-shipped options; TS lib doesn't know them all.
    systemAudio: "include",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include", // native "share a different window" control
  } as DisplayMediaStreamOptions);

  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack =
    opts.audioTrackOverride ?? stream.getAudioTracks()[0] ?? null;
  let currentAudioTrack = audioTrack;
  const videoMode: VideoModeName = opts.videoMode ?? "motion";
  if ("contentHint" in videoTrack)
    videoTrack.contentHint = videoMode === "text" ? "detail" : "motion";

  const room = new Room({ dynacast: true });
  (globalThis as { __essRoom?: Room }).__essRoom = room; // e2e/debug handle
  try {
    await room.connect(opts.livekitUrl, opts.token);
  } catch (e) {
    videoTrack.stop();
    audioTrack?.stop();
    throw e;
  }

  const videoPub = await room.localParticipant.publishTrack(videoTrack, {
    source: Track.Source.ScreenShare,
    simulcast: true,
    videoCodec: "h264",
    // Top layer: native resolution at 60 fps, screen-content bitrate ceiling.
    screenShareEncoding: { maxBitrate: 8_000_000, maxFramerate: 60, priority: "high" },
    screenShareSimulcastLayers: [ScreenSharePresets.h720fps30],
  });
  setDegradationPreference(
    videoPub,
    videoMode === "text" ? "maintain-resolution" : "maintain-framerate",
  );

  let audioPub: LocalTrackPublication | undefined;
  if (audioTrack) {
    audioPub = await room.localParticipant.publishTrack(audioTrack, {
      source: Track.Source.ScreenShareAudio,
      dtx: false,
      red: false,
      forceStereo: true,
      audioPreset: { maxBitrate: AUDIO_PRESETS[opts.audioPreset].maxBitrate },
    });
    // Loopback capture tracks fire browser-level `mute` events when the
    // source goes quiet; LiveKit reacts by pausing the upstream
    // (replaceTrack(null)) AND signaling MUTED to viewers — identical to
    // the sharer pressing "Mute audio", with nobody pressing anything
    // (field-hit: a viewer's unmute during such a window plays nothing).
    // For a screen share, silence IS content — keep the upstream alive.
    const localAudio = audioPub.track;
    if (localAudio && "resumeUpstream" in localAudio) {
      localAudio.on(TrackEvent.UpstreamPaused, () => {
        void localAudio.resumeUpstream();
      });
    }
  }

  const stopHeartbeat = opts.heartbeat
    ? startHeartbeat(
        opts.heartbeat.sessionId,
        opts.heartbeat.secret,
        opts.heartbeat.baseUrl,
      )
    : () => {};

  let currentVideoTrack = videoTrack;
  let audioMuted = false;
  const endedCallbacks: Array<() => void> = [];
  const wireEnded = (t: MediaStreamTrack) =>
    t.addEventListener("ended", () => {
      for (const cb of endedCallbacks) cb();
    });
  wireEnded(videoTrack);

  return {
    room,
    hasAudio: audioTrack !== null,
    // Live, blip-free switching: Opus bitrate is a sender parameter, applied to
    // the running encoder with no renegotiation (research 04 §5).
    async setAudioPreset(name) {
      const sender = trackSender(audioPub);
      if (!sender) return;
      const params = sender.getParameters();
      params.encodings = params.encodings.map((e) => ({
        ...e,
        maxBitrate: AUDIO_PRESETS[name].maxBitrate,
      }));
      await sender.setParameters(params);
    },
    async setAudioMuted(muted) {
      audioMuted = muted;
      if (!audioPub) return;
      if (muted) await audioPub.mute();
      else await audioPub.unmute();
    },
    async replaceAudioTrack(track) {
      const lt = audioPub?.track as unknown as
        | { replaceTrack?: (t: MediaStreamTrack) => Promise<void> }
        | undefined;
      if (!lt?.replaceTrack) {
        track.stop();
        return;
      }
      await lt.replaceTrack(track);
      if (audioMuted) track.enabled = false; // a source switch must not unmute
      currentAudioTrack?.stop();
      currentAudioTrack = track;
    },
    async replaceVideoTrack(track) {
      const lt = videoPub.track as unknown as
        | { replaceTrack?: (t: MediaStreamTrack) => Promise<void> }
        | undefined;
      if (!lt?.replaceTrack) {
        track.stop();
        return;
      }
      if ("contentHint" in track)
        track.contentHint = videoMode === "text" ? "detail" : "motion";
      await lt.replaceTrack(track);
      currentVideoTrack.stop();
      currentVideoTrack = track;
      wireEnded(track); // browser "stop sharing" on the NEW surface still ends us
    },
    async setVideoMode(name) {
      if ("contentHint" in videoTrack)
        videoTrack.contentHint = name === "text" ? "detail" : "motion";
      setDegradationPreference(
        videoPub,
        name === "text" ? "maintain-resolution" : "maintain-framerate",
      );
    },
    onEnded(cb) {
      endedCallbacks.push(cb);
    },
    async stop() {
      stopHeartbeat();
      currentVideoTrack.stop();
      currentAudioTrack?.stop();
      await room.disconnect();
    },
  };
}

function trackSender(pub: LocalTrackPublication | undefined): RTCRtpSender | undefined {
  const track = pub?.track as { sender?: RTCRtpSender } | undefined;
  return track?.sender;
}

function setDegradationPreference(
  pub: LocalTrackPublication,
  pref: RTCDegradationPreference,
) {
  const sender = trackSender(pub);
  if (!sender) return;
  try {
    const params = sender.getParameters();
    (params as RTCRtpSendParameters).degradationPreference = pref;
    void sender.setParameters(params);
  } catch {
    // Best-effort: contentHint above still steers the encoder.
  }
}

/** True when this browser can capture system audio at all (Chromium-only). */
export function browserSupportsSystemAudio(): boolean {
  const ua = navigator.userAgent;
  const isChromium =
    "chrome" in window || /Chrom(e|ium)|Edg\//.test(ua) === true;
  return isChromium;
}
