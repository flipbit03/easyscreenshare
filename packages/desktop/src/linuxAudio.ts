// Linux per-app audio, zero native code: a private PipeWire virtual source
// ("easyscreenshare_stream_audio") that we wire app playback streams into with pw-link.
//
// PipeWire lets one output port feed many inputs, so linking an app's output
// into our source is a TAP — the user keeps hearing everything normally.
// Muting an app in the stream = not linking it; "only this app" = linking
// only it. The renderer captures the source with getUserMedia (deviceId by
// label). Chromium's own loopback can only tap the default sink's monitor
// (whole system), which is why this exists.
//
// Verified 2026-11-08 on Nobara/Fedora 44, PipeWire 1.6.9 (pipewire-pulse),
// KDE Wayland, Electron 44: linked stream audible in the capture, unlinked
// streams absent. Levels are post stream-volume, pre sink/master volume.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";

/** node.name of the virtual source. NOT "easyscreenshare": the packaged
 * app's own capture stream is named after its binary, and a name clash made
 * the router reconcile the wrong node (field-hit: Discord stayed linked). */
export const SOURCE_NAME = "easyscreenshare_stream_audio";
export const SOURCE_LABEL = "easyscreenshare-stream-audio";

export interface StreamApp {
  /** Normalized key: lowercase process binary (fallback: app name). */
  name: string;
}

interface PwObj {
  id: number;
  type: string;
  info?: {
    props?: Record<string, unknown>;
    direction?: string;
    // pw-dump spells link endpoints with hyphens.
    "output-port-id"?: number;
    "input-port-id"?: number;
  };
}

/** Our stereo input channel(s) for an app port channel; [] = don't route. */
const routeChannel = (ch: string): ("FL" | "FR")[] => {
  switch (ch) {
    case "FL":
    case "SL":
    case "RL":
    case "FLC":
    case "AUX0":
      return ["FL"];
    case "FR":
    case "SR":
    case "RR":
    case "FRC":
    case "AUX1":
      return ["FR"];
    case "LFE":
      return [];
    default: // MONO, FC, RC, unknown: centre → both sides
      return ["FL", "FR"];
  }
};

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 64 * 1024 * 1024 }, (err, out) =>
      err ? reject(err) : resolve(out),
    );
  });

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Normalized app key for a playback stream node. Flatpak Discord reports
 * binary "Discord" → "discord", matching the Windows exe-derived names. */
const appKey = (props: Record<string, unknown>): string =>
  (str(props["application.process.binary"]) || str(props["application.name"]))
    .toLowerCase()
    .replace(/\.exe$/, "")
    .trim();

/** App playback streams worth routing: real apps, not filter chains /
 * loopbacks / effects (those carry node.link-group and would double audio). */
const appStreams = (dump: PwObj[]) =>
  dump.filter((o) => {
    if (o.type !== "PipeWire:Interface:Node") return false;
    const p = o.info?.props ?? {};
    if (p["media.class"] !== "Stream/Output/Audio") return false;
    if (p["node.link-group"]) return false;
    const key = appKey(p);
    if (!key || key.includes("easyeffects") || key === "easyscreenshare") return false;
    if (Number(p["application.process.id"]) === process.pid) return false;
    return true;
  });

/** Apps currently holding a playback stream (works without the router). */
export async function listStreamApps(): Promise<StreamApp[]> {
  try {
    const dump = JSON.parse(await run("pw-dump", [])) as PwObj[];
    const names = new Set(appStreams(dump).map((n) => appKey(n.info!.props!)));
    return [...names].sort().map((name) => ({ name }));
  } catch {
    return [];
  }
}

/** Remove virtual sources left by a crashed/killed previous run. */
function unloadStale() {
  try {
    const mods = execFileSync("pactl", ["list", "short", "modules"], {
      encoding: "utf8",
      timeout: 3000,
    });
    for (const line of mods.split("\n")) {
      // Also the pre-rename name, left by builds before 2026-11-08.
      const ours = [SOURCE_NAME, "easyscreenshare"].some((n) =>
        line.includes(`sink_name=${n} `),
      );
      if (line.includes("module-null-sink") && ours) {
        execFileSync("pactl", ["unload-module", line.split("\t")[0]], { timeout: 3000 });
      }
    }
  } catch {
    /* pactl missing or nothing to clean */
  }
}

export class PipeWireRouter {
  private moduleId: string | null = null;
  private watcher: ChildProcess | null = null;
  private poll: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;
  private again = false;
  /** Which apps go into the stream. */
  private wants: (app: string) => boolean = () => true;
  /** Fires with the live app list after every sync. */
  onApps: (apps: StreamApp[]) => void = () => {};

  get running() {
    return this.moduleId !== null;
  }

  async start(): Promise<void> {
    if (this.moduleId) return;
    unloadStale();
    this.moduleId = (
      await run("pactl", [
        "load-module",
        "module-null-sink",
        `sink_name=${SOURCE_NAME}`,
        "media.class=Audio/Source/Virtual",
        "channel_map=front-left,front-right",
        // priority.session=0: never auto-picked as anyone's default mic.
        // Quoted: module args are space-separated key=value pairs.
        `sink_properties="device.description=${SOURCE_LABEL} priority.session=0 priority.driver=0"`,
      ])
    ).trim();
    // Event-driven: new app streams get linked within ~150 ms of appearing.
    this.watcher = spawn("pactl", ["subscribe"], { stdio: ["ignore", "pipe", "ignore"] });
    this.watcher.stdout?.on("data", (buf: Buffer) => {
      if (/sink-input|'new' on source/.test(buf.toString())) this.schedule();
    });
    this.watcher.on("error", () => {});
    this.poll = setInterval(() => this.schedule(), 3000); // belt + braces
    await this.sync();
  }

  setFilter(wants: (app: string) => boolean) {
    this.wants = wants;
    this.schedule(0);
  }

  private schedule(delay = 150) {
    if (!this.moduleId) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.sync(), delay);
  }

  /** Reconcile pw links into our source with the current filter. */
  async sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.again = false;
        try {
          await this.reconcile();
        } catch (e) {
          console.error("pipewire sync failed:", e);
        }
      } while (this.again && this.moduleId);
    })().finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async reconcile() {
    if (!this.moduleId) return;
    const dump = JSON.parse(await run("pw-dump", [])) as PwObj[];
    const ports = dump.filter((o) => o.type === "PipeWire:Interface:Port");
    const ours = dump.find(
      (o) =>
        o.type === "PipeWire:Interface:Node" &&
        o.info?.props?.["node.name"] === SOURCE_NAME &&
        o.info?.props?.["media.class"] === "Audio/Source/Virtual",
    );
    if (!ours) return;
    const inPort: Record<string, number> = {};
    for (const p of ports) {
      const pp = p.info?.props ?? {};
      if (Number(pp["node.id"]) === ours.id && p.info?.direction === "input") {
        inPort[str(pp["audio.channel"])] = p.id;
      }
    }
    const ourIns = new Set(Object.values(inPort));

    const streams = appStreams(dump);
    const apps = [...new Set(streams.map((n) => appKey(n.info!.props!)))].sort();
    const wanted = new Set(
      streams.filter((n) => this.wants(appKey(n.info!.props!))).map((n) => n.id),
    );

    const desired = new Set<string>();
    for (const p of ports) {
      const pp = p.info?.props ?? {};
      if (p.info?.direction !== "output" || pp["port.monitor"]) continue;
      if (!wanted.has(Number(pp["node.id"]))) continue;
      for (const ch of routeChannel(str(pp["audio.channel"]))) {
        if (inPort[ch] != null) desired.add(`${p.id}:${inPort[ch]}`);
      }
    }

    const existing = new Map<string, number>();
    for (const l of dump) {
      if (l.type !== "PipeWire:Interface:Link") continue;
      const i = l.info?.["input-port-id"];
      if (i != null && ourIns.has(i)) existing.set(`${l.info!["output-port-id"]}:${i}`, l.id);
    }

    const ops: Promise<unknown>[] = [];
    for (const k of desired) {
      if (!existing.has(k)) {
        const [o, i] = k.split(":");
        ops.push(run("pw-link", [o, i]).catch(() => {})); // port may have vanished
      }
    }
    for (const [k, id] of existing) {
      if (!desired.has(k)) ops.push(run("pw-link", ["-d", String(id)]).catch(() => {}));
    }
    await Promise.all(ops);
    this.onApps(apps.map((name) => ({ name })));
  }

  /** Synchronous so it also runs on quit paths that don't await. */
  stop() {
    if (this.debounce) clearTimeout(this.debounce);
    if (this.poll) clearInterval(this.poll);
    this.debounce = this.poll = null;
    this.watcher?.kill();
    this.watcher = null;
    if (this.moduleId) {
      try {
        execFileSync("pactl", ["unload-module", this.moduleId], { timeout: 3000 });
      } catch {
        /* already gone */
      }
    }
    this.moduleId = null; // unloading the module drops all our links with it
  }
}
