// Per-app audio mixer: one include-mode capture per app tree, mixed with
// Web Audio into ONE MediaStreamTrack that stays alive for the whole share.
// Exclusions are gain nodes at zero (instant toggles); apps appearing or
// dying mid-stream are wired in/out of the live graph without touching the
// published track.
import { SYSTEM_AUDIO_CONSTRAINTS } from "@easyscreenshare/core";
import type { AudioRoot, EssBridge } from "./preload";

interface Channel {
  name: string;
  gain: GainNode;
  tracks: MediaStreamTrack[];
}

export class AppAudioMixer {
  private ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  private destination = this.ctx.createMediaStreamDestination();
  private limiter = this.ctx.createDynamicsCompressor();
  private channels = new Map<number, Channel>();
  private excluded = new Set<string>();
  private ess: EssBridge;

  constructor(ess: EssBridge, excludedApps: string[]) {
    this.ess = ess;
    this.excluded = new Set(excludedApps);
    // Gentle limiter so N summed apps can't clip the mix.
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.connect(this.destination);
    void this.ctx.resume();
  }

  get track(): MediaStreamTrack {
    return this.destination.stream.getAudioTracks()[0];
  }

  get size(): number {
    return this.channels.size;
  }

  /** Sequentially captures every root. Individual failures are skipped —
   * a rare uncapturable app must not sink the whole share. */
  async addAll(roots: AudioRoot[]): Promise<number> {
    let ok = 0;
    for (const root of roots) {
      if (await this.add(root)) ok++;
    }
    return ok;
  }

  async add(root: AudioRoot): Promise<boolean> {
    if (this.channels.has(root.pid)) return true;
    try {
      await this.ess.armAudio(root.pid);
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // required by gDM; stopped immediately below
        audio: SYSTEM_AUDIO_CONSTRAINTS,
      } as DisplayMediaStreamOptions);
      for (const t of stream.getVideoTracks()) t.stop();
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) return false;
      const source = this.ctx.createMediaStreamSource(
        new MediaStream(audioTracks),
      );
      const gain = this.ctx.createGain();
      gain.gain.value = this.excluded.has(root.name) ? 0 : 1;
      source.connect(gain).connect(this.limiter);
      this.channels.set(root.pid, { name: root.name, gain, tracks: audioTracks });
      return true;
    } catch (e) {
      console.warn(`mixer: capture failed for ${root.name} (${root.pid})`, e);
      return false;
    }
  }

  remove(pid: number) {
    const ch = this.channels.get(pid);
    if (!ch) return;
    for (const t of ch.tracks) t.stop();
    ch.gain.disconnect();
    this.channels.delete(pid);
  }

  setExcluded(excludedApps: string[]) {
    this.excluded = new Set(excludedApps);
    for (const ch of this.channels.values()) {
      ch.gain.gain.value = this.excluded.has(ch.name) ? 0 : 1;
    }
  }

  async sync(diff: { add: AudioRoot[]; remove: number[] }) {
    for (const pid of diff.remove) this.remove(pid);
    await this.addAll(diff.add);
  }

  stop() {
    for (const pid of [...this.channels.keys()]) this.remove(pid);
    void this.ctx.close();
  }
}
