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
  type LocalTrackPublication,
} from "livekit-client";

export type AudioPresetName = "voice" | "balanced" | "music";

export const AUDIO_PRESETS: Record<
  AudioPresetName,
  { maxBitrate: number; label: string; hint: string }
> = {
  voice: { maxBitrate: 64_000, label: "Voice", hint: "talking, screencasts" },
  balanced: { maxBitrate: 128_000, label: "Balanced", hint: "general use" },
  music: { maxBitrate: 256_000, label: "Music", hint: "Spotify, games, film" },
};

export interface StartOptions {
  livekitUrl: string;
  token: string;
  audio: boolean;
  audioPreset: AudioPresetName;
}

export interface PublishHandle {
  room: Room;
  /** False when the browser/OS could not provide system audio. */
  hasAudio: boolean;
  setAudioPreset(name: AudioPresetName): Promise<void>;
  /** Fired when capture ends outside our UI (browser's own "stop sharing"). */
  onEnded(cb: () => void): void;
  stop(): Promise<void>;
}

export async function startScreenShare(opts: StartOptions): Promise<PublishHandle> {
  // Capture at NATIVE resolution — getDisplayMedia constraints are hints only;
  // real ceilings are enforced at the encoder via simulcast layers (research 02 §3).
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 } },
    audio: opts.audio
      ? ({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: 48000,
          restrictOwnAudio: true,
        } as MediaTrackConstraints)
      : false,
    // Non-standard-but-shipped options; TS lib doesn't know them all.
    systemAudio: "include",
    selfBrowserSurface: "exclude",
  } as DisplayMediaStreamOptions);

  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0] ?? null;
  if ("contentHint" in videoTrack) videoTrack.contentHint = "detail";

  const room = new Room({ dynacast: true });
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
    screenShareEncoding: ScreenSharePresets.h1080fps30.encoding,
    screenShareSimulcastLayers: [ScreenSharePresets.h720fps15],
  });
  setDegradationPreference(videoPub, "maintain-resolution");

  let audioPub: LocalTrackPublication | undefined;
  if (audioTrack) {
    audioPub = await room.localParticipant.publishTrack(audioTrack, {
      source: Track.Source.ScreenShareAudio,
      dtx: false,
      red: false,
      forceStereo: true,
      audioPreset: { maxBitrate: AUDIO_PRESETS[opts.audioPreset].maxBitrate },
    });
  }

  const endedCallbacks: Array<() => void> = [];
  videoTrack.addEventListener("ended", () => {
    for (const cb of endedCallbacks) cb();
  });

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
    onEnded(cb) {
      endedCallbacks.push(cb);
    },
    async stop() {
      videoTrack.stop();
      audioTrack?.stop();
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
