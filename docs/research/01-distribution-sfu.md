# WebRTC Screen-Share Distribution: 2026 State of the Art

> Research report produced 2026-08-26. Scope: distributing one publisher's screen+audio
> stream to N anonymous browser viewers with sub-second latency, Discord-like quality
> tiers (720p/1080p/native × 15/30/60fps), viewers mostly in Brazil, small scale
> (1–10 streams, 1–20 viewers each).

**Bottom line:** Self-host **LiveKit** (Apache 2.0, single Go binary) on a **Vultr São Paulo** VPS. It is the only option that gives you viewer-selectable quality tiers, bandwidth-adaptive fallback, an embedded TURN server, and a production-grade browser SDK without you writing any of it — and at your scale it costs roughly **$25–50/month** versus **$150–600/month** for every managed alternative. Runner-up: **Broadcast Box** (WHIP/WHEP, Pion) if you'd rather trade features for radical simplicity.

---

## 1. Media server comparison (2026)

| | Language / footprint | License | Simulcast | SVC | Built-in TURN | Browser SDK | WHIP / WHEP | Health 2026 |
|---|---|---|---|---|---|---|---|---|
| **LiveKit** | Go, single binary + Redis (multi-node only) | Apache 2.0 | Yes, custom per-layer res **and** fps | VP9/AV1, auto `L3T3_KEY` | **Yes** (TURN/UDP + TURN/TLS:443) | Best in class (`livekit-client`, adaptiveStream, `setVideoQuality`) | WHIP in (separate Ingress svc); **no WHEP** | Very active, ~43 commits/4wk |
| **mediasoup** | C++/Rust worker + Node API; a *library*, not a server | ISC | Yes | Yes | No | `mediasoup-client` (low-level; you build signaling) | Neither natively | Active, v3.26.0 (Aug 2026) |
| **Janus** | C, plugin-per-use-case | **GPLv3** (commercial license available) | Yes | Yes | No | Thin JS lib; you assemble everything | Yes, via Meetecho's `simple-whip-server` / `simple-whep-server` (separate Node procs) | Maintained but slow: ~4 commits/4wk |
| **Galène** | Go (Pion v4), single binary, MIT | MIT | Yes (VP8/VP9) | Yes (VP8/VP9) | **Yes** | Fixed conference UI — fork or embed | WHIP ingress only | Active; ~300 one-to-many participants **per CPU core** |
| **Jitsi Videobridge** | Java (JVM), monolithic stack (Jicofo, Prosody, JVB) | Apache 2.0 | Yes | Yes | Via separate coturn | Excellent but opinionated (Jitsi Meet) | Not natively | Very active, ~64 commits/4wk |
| **Broadcast Box** (Pion) | Go + React, single binary | MIT | Yes, with **WHEP layer-selection extension** + SSE | No | **No** (STUN only) | You write the WHEP client (~50 lines) | **Yes, both** — this is its whole design | ~900 commits, small but alive |
| **MediaMTX** | Go, zero-dependency binary | MIT | **Ingest only** | No | No | Built-in player | **Yes, both** | Very active (19.9k★), v1.17.0 Mar 2026 |

### The two disqualifications worth knowing

**MediaMTX cannot fan out simulcast to WebRTC viewers.** The maintainer confirmed on 19 Mar 2026 that v1.17.0 added simulcast *publishing* only; WebRTC playback still negotiates a plain single-video session with no `a=simulcast`/`a=rid`, and there is no layer-selection or adaptive switching for WHEP consumers. He opened #5596 to track it. MediaMTX is a superb protocol bridge (RTSP↔RTMP↔SRT↔HLS↔WebRTC) but it is **not an SFU**, and the quality-tier requirement is exactly the thing it can't do.

**LiveKit has no WHEP.** Issue #2811 was closed as *not planned*. Viewers must load `livekit-client`. For a browser link this is a non-issue (it's just a JS bundle), but don't plan on WHEP interop.

---

## 2. Simulcast vs SVC, and the codec question

### Browser support, honestly

In 2026 simulcast is the default for **VP8 and H.264 across every browser**; SVC is the default for **VP9 and AV1 in Chromium**. Chrome/Edge do VP8, VP9, H.264, AV1. Firefox does VP8 and H.264 reliably, VP9 partially. VP9/AV1 *simulcast* (as opposed to SVC) has been available since Chrome 113. Safari remains the constraint — always keep an H.264 path.

### Can layers differ in framerate? Yes — two independent mechanisms

**Per-encoding `maxFramerate` (simulcast).** LiveKit's own `ScreenSharePresets` are proof this works in production — from `client-sdk-js/src/room/track/options.ts`:

| Preset | Resolution | Bitrate | FPS |
|---|---|---|---|
| `h360fps15` | 640×360 | 400 kbps | 15 |
| `h720fps15` | 1280×720 | 1.5 Mbps | 15 |
| `h720fps30` | 1280×720 | 2.0 Mbps | 30 |
| `h1080fps15` | 1920×1080 | 2.5 Mbps | 15 |
| `h1080fps30` | 1920×1080 | 5.0 Mbps | 30 |
| `original` | native | 7.0 Mbps | 30 |

**Temporal layers (`L1T3`).** The SFU drops temporal layers to halve/quarter framerate without a keyframe — 60 → 30 → 15 exactly. Constraint: with multiple active simulcast encodings, Chrome supports only `L1T1`/`L1T2`/`L1T3` and **all encodings must use the same value**.

**The 60fps gotcha:** LiveKit ships no preset above 30 fps, and issue #1822 (opened 25 Feb 2026, still open) requests one, explicitly citing Discord parity. The presets are just convenience objects — you can pass `maxFramerate: 60` in a custom encoding yourself. Budget a day to validate it end-to-end.

### Codec recommendation

**Default to H.264 simulcast. Offer VP9 as an opt-in "sharp text" mode. Skip AV1 for now.**

Benchmarks from webrtc-developers.com and gethopp's LiveKit-specific tests:

- **AV1** is the quality winner for text — readable at 200–600 kbps, stays sharp during scrolling — but costs 225% CPU peak on Windows (111–147% in the LiveKit test) and, critically, **does not do simulcast** (SVC only), which complicates the tier story.
- **VP9** cut bandwidth dramatically in the LiveKit test (0.16–0.38 Mbps vs VP8's 0.36–0.90 Mbps at matched VMAF 96–97) and is LiveKit's own quality recommendation.
- **H.264** struggles below 1 Mbps but has hardware encode/decode nearly everywhere; it was lowest-latency on Windows. LiveKit recommends it for CPU-constrained publishers.
- **VP8** was lowest-latency on macOS but worst quality for screen content.

**AV1 screen-content coding is not usable in WebRTC in 2026.** fippo's explainer proposes it as a **WebCodecs** flag (`av1: { forceScreenContentTools: true }`), still requires a patched Chromium, and has no `RTCRtpEncodingParameters` surface at all. Measured gains: ~10% bitrate reduction and notably sharper text at 100 kbps — but **20–30% larger frames on non-slide content like video**. Broad device support is projected for 2027–2028.

**Two traps to set correctly:**
1. Set `track.contentHint = 'text'` (or `'detail'`) so degradation prefers `maintain-resolution` — for code and spreadsheets you want a crisp frame at 2 fps, not mush at 30. But there is a long-standing Chrome bug (issues.webrtc.org/issues/42223195) where `contentHint="detail"` **clamps VP9 to 5 fps**, and reports that `contentHint` does not reliably set `degradationPreference` in practice. Set `degradationPreference` explicitly rather than relying on the hint.
2. Encoding three 1080p layers simultaneously is expensive on the publisher. LiveKit's **Dynacast** pauses layers no one is subscribed to, which largely neutralizes this. Note it can only pause *entire streams* for SVC codecs, not individual layers — another point for simulcast over SVC in this case.

---

## 3. WHIP/WHEP vs a full SFU

WHIP is now universal for ingest (Cloudflare Stream, AWS IVS, Dolby, Mux, Wowza, Millicast, Ant Media, OBS). WHEP is thinner but real — running in production on Cloudflare Stream, Dolby Millicast, OvenMediaEngine, MediaMTX, Janus, and Ant Media as of May 2026. RFC 9725 standardized WHIP in March 2025.

**For our shape, WHIP/WHEP is genuinely simpler — but we don't actually need WHIP.** The publisher is an Electron app, so it can use the LiveKit JS SDK directly as a native participant. WHIP's value is letting *OBS and hardware encoders* publish; we have neither. So the honest comparison is "WHEP playback vs an SDK," and there the SDK wins: `adaptiveStream` and `setVideoQuality` are done, whereas WHEP layer switching is an unratified extension each server implements differently ("the WHEP spec leaves layer switching to extensions").

Broadcast Box does implement it properly — its Link headers advertise both `urn:ietf:params:whep:ext:core:server-sent-events` and `urn:ietf:params:whep:ext:core:layer`, so you get SSE-pushed layer availability plus a POST endpoint to switch. That's the good version of WHEP.

**Trade-off summary:** WHIP/WHEP buys a smaller viewer bundle, no room/token concepts, and vendor portability. A LiveKit room buys a battle-tested adaptive client, embedded TURN, E2EE, and a hosted escape hatch. For 1→20 viewers with quality tiers, the SFU's client-side maturity is worth more than WHEP's protocol purity.

---

## 4. Managed alternatives

| | Pricing | Free tier | Brazil presence | Verdict |
|---|---|---|---|---|
| **Cloudflare Realtime SFU** | **$0.05/GB egress** (ingest free) | **1,000 GB/mo**, shared with TURN | **33 Brazilian cities**, 60+ DCs; anycast, ~95% of users within 50 ms | Best managed value. Simulcast supported since ~Apr 2026 with `preferredRid` layer selection via `/tracks/update` |
| **LiveKit Cloud** | Ship $50/mo + 250 GB then **$0.12/GB**; Scale $500/mo + 3 TB then $0.10/GB | Build: 50 GB egress | `sa` region group exists (South America/Brazil) | Same SDK as self-hosted — a zero-code migration path, but 2–10× the cost |
| **Amazon IVS Real-Time** | **$0.084/participant-hour** in South America (first 10k hrs) | 20 participant-hrs/mo for 12 months | South America billing region covers Brazil | **Disqualified: hard 720p cap, H.264 Baseline only, no B-frames.** Kills "native resolution" outright |

Cloudflare's anycast architecture is technically the most elegant here — per-track cascading trees across 310+ cities, no room concept, no participant limit. If we ever decide not to self-host, this is the one.

---

## 5. Self-hosting: the numbers

### Bandwidth math

Egress per viewer-hour = bitrate (Mbps) × 0.45 GB.

| Tier | Bitrate | GB / viewer-hr | 20 viewers × 1 hr | 20 viewers × 3 hr/day × 30 days |
|---|---|---|---|---|
| 720p15 | 1.5 Mbps | 0.68 GB | 13.5 GB | 1.2 TB |
| 720p30 | 2.0 Mbps | 0.90 GB | 18 GB | 1.6 TB |
| 1080p30 | 5.0 Mbps | 2.25 GB | 45 GB | **4.1 TB** |
| 1080p60 | ~8 Mbps | 3.60 GB | 72 GB | 6.5 TB |

1080p60 has no WebRTC preset to cite; 4.5–9 Mbps is the standard H.264 guidance for 1080p60, and screen content is bimodal — near-zero when idle, spiking hard on scroll or embedded video.

**Two ceilings to watch:**
- **Peak concurrent egress**, not monthly total, is what breaks things. 10 streams × 20 viewers × 5 Mbps = **1 Gbps**, which saturates a standard VPS NIC. Monthly volume is trivial; peak is not.
- **CPU is a non-issue.** LiveKit's published benchmark is **1 publisher → 3,000 subscribers at 92% CPU** on a 16-core c2-standard-16, pushing 531 MBps out. You need 2–4 vCPU. An SFU doesn't transcode.

### Cost at 4 TB/month (the 1080p30 scenario)

| Option | Monthly cost |
|---|---|
| **Vultr São Paulo** (~$24 instance, 3–4 TB included, $0.01/GB over) | **~$35** |
| Amazon IVS Real-Time (1,890 participant-hrs) | ~$159 — *but 720p max* |
| Cloudflare Realtime (3 TB billable) | ~$150 |
| LiveKit Cloud Scale | ~$600 |
| Self-host on **AWS sa-east-1** (egress alone) | **~$560** |

### VPS providers with São Paulo

- **Vultr — the pick.** São Paulo region, **$0.01/GB overage globally with no regional variation**, 2 TB/mo free egress pooled account-wide plus per-instance allowances (a $20/mo 2 vCPU/4 GB plan includes 3 TB), free ingress.
- **Magalu Cloud** — São Paulo, BRL billing with no FX exposure, 5–15 ms to SP, LGPD residency, and roughly **19% of GCP's VM price** (R$83 vs R$486 for 2 vCPU/4 GB). Verify egress terms before committing; the residency and BRL story is real but the platform is young.
- **Oracle Cloud São Paulo — avoid.** The 10 TB/mo free egress is the best headline in the industry, but Oracle **quietly halved Always Free ARM to 2 OCPU / 12 GB effective 18 Aug 2026**, and `sa-saopaulo-1`/`sa-vinhedo-1` have chronic A1 capacity shortages where free accounts simply cannot launch instances. Don't build on it.
- **AWS / GCP / Azure Brazil — avoid for media egress.** AWS São Paulo is **$0.14–0.15/GB**, the most expensive region AWS operates. That's 14× Vultr.
- **DigitalOcean — no South American region exists.** There's a standing customer feature request for a Brazil datacenter.

### TURN, ports, TLS

**TURN is required, and LiveKit's embedded one is sufficient.** With the SFU on a public IP, most viewers connect via server-reflexive candidates. But 2026 field data puts TURN relay at **20–30% of connections generally and 60–85% inside managed corporate firewalls** where UDP is blocked outright. The fix is TURN over TCP/TLS on **port 443**, which is essentially never blocked. LiveKit ships this natively (`turn.tls` on 5349, or 443 directly with no load balancer) — no separate coturn deployment. Galène also has a built-in TURN. **Broadcast Box does not**, which is its biggest operational gap.

**LiveKit ports:** TCP 443 (WSS signaling via reverse proxy), TCP 7880/7881 (signaling + ICE/TCP fallback), UDP 50000–60000 or a single muxed UDP port, TURN/TLS on 5349 or 443. **A real domain and a trusted-CA certificate are mandatory — self-signed certificates do not work.** Let's Encrypt is fine. Redis is only needed for multi-node.

---

## 6. E2EE feasibility

**This is more practical than it was a year ago.** The standardized `RTCRtpScriptTransform` (Encoded Transform, the successor to Insertable Streams) **reached cross-browser Baseline in October 2025** — Safari shipped it first in 2022, Firefox from FF117, Chrome since. Any source claiming Safari can't do insertable-streams E2EE is out of date.

**Support by server:** LiveKit has first-class E2EE across Web/iOS/Android, available on self-hosted and Cloud **at no extra cost**, configured via the `encryption` field in `RoomOptions`. Jitsi supports it in Chromium. mediasoup and Janus support it via custom frame transformers — Meetecho published a working SFrame integration, but you're wiring it yourself.

**Complexity cost:**
- **Key distribution is entirely on you.** LiveKit is explicit: "it is your responsibility to securely generate, store, and distribute encryption keys."
- **Signaling is not encrypted** — room metadata, participant identity, and API calls remain visible to the server.
- **It kills server-side features**: recording, egress, transcoding, and any server-side composition all break, because the SFU is demoted to a blind packet courier.
- Simulcast still works (the SFU routes on unencrypted RTP headers), but the server loses all frame-level intelligence.

**For a link-based anonymous viewer product, there's one design that makes E2EE meaningful rather than theatrical:** put the room key in the **URL fragment** (`https://you.app/s/abc123#k=<key>`). Fragments are never transmitted to the server, so the link itself becomes the credential and the server genuinely cannot decrypt the stream. That's a real privacy claim you can defend. Without that, E2EE against a server you also operate is mostly marketing.

Recommendation: **build it, ship it off by default**, expose it as a "private stream" toggle. With LiveKit it's roughly a day of work; anywhere else it's a week or more.

---

## 7. Recommended default + runner-up

### Default: LiveKit, self-hosted on Vultr São Paulo

Everything asked for is a configuration decision rather than an engineering project:

- **Quality tiers** map onto custom simulcast layers with distinct resolution *and* framerate — LiveKit's own screen-share presets already prove the pattern (`h720fps15` / `h720fps30` / `h1080fps30`). Note the SDK always publishes the original full-resolution layer plus up to two configured layers.
- **Viewer-selectable:** `setVideoQuality(VideoQuality.LOW|MID|HIGH)` on the remote publication.
- **Bandwidth-adaptive:** `adaptiveStream` monitors the size and visibility of the video element and negotiates the right layer automatically, pausing the track server-side when hidden.
- **Publisher cost control:** Dynacast pauses layers nobody is watching.
- **Anonymous link access:** mint a short-lived subscribe-only JWT server-side when the page loads. No account, no install.
- **Electron publisher:** uses the same JS SDK — no WHIP, no Ingress service, no extra moving parts.
- **Escape hatch:** if one box isn't enough, LiveKit Cloud's `sa` region takes the identical client code.

Sizing: 2–4 vCPU, ~$25/mo instance, ~$35/mo all-in at 4 TB. Provision headroom on the NIC, not the CPU.

### Runner-up: Broadcast Box (Pion, WHIP/WHEP)

MIT, single Go binary plus a React frontend, purpose-built for exactly "one broadcaster, many browser viewers, sub-second." It implements the WHEP layer-selection extension with SSE-pushed layer availability, has bearer-token and webhook auth on both endpoints, and does automatic Let's Encrypt via Docker Compose. It even runs a network self-test at startup.

Take it if you value a comprehensible codebase over features. Accept in exchange: **no built-in TURN** (add coturn or lose corporate-network viewers), H.264-centric codec support, a WHEP client you write yourself, no E2EE story, and a much smaller project behind you.

### Dark horse worth 30 minutes: Galène

MIT, Go/Pion v4, **built-in TURN**, simulcast *and* SVC for VP8/VP9, WHIP ingress, congestion control, and a resource profile that is hard to beat — **~300 participants per CPU core** for one-to-many, scaling linearly. The catch is that it's a videoconference product with a fixed web client; you'd fork or embed rather than integrate. If you want the absolute minimum ops surface and can live with its UI, it's a legitimate contender.

### Do not pick

**MediaMTX** (no WebRTC simulcast playback — the tier feature is impossible), **Amazon IVS Real-Time** (hard 720p cap, H.264 Baseline only), **Janus** (GPLv3 plus you'd assemble WHIP/WHEP glue servers for no gain), **mediasoup** (you'd build signaling, rooms, and reconnection from scratch — it's a library, not a server), **Jitsi** (conference-shaped monolith on the JVM; a single JVB tops out around 75–100 users and you'd be fighting its opinions the whole way).

---

## Sources

**Media servers**
- https://bloggeek.me/webrtc-tools/media-servers-oss/
- https://webrtc.ventures/2026/06/open-source-webrtc-media-servers/
- https://www.forasoft.com/learn/video-streaming/articles-streaming/sfu-comparison-mediasoup-janus-livekit-jitsi-pion
- https://github.com/versatica/mediasoup and https://github.com/versatica/mediasoup/blob/v3/LICENSE
- https://janus.conf.meetecho.com/docs/COPYING.html
- https://galene.org/
- https://github.com/Glimesh/broadcast-box
- https://github.com/bluenviron/mediamtx
- https://github.com/bluenviron/mediamtx/discussions/5594
- https://jitsi.org/blog/low-latency-conference-streaming-to-very-large-audiences/

**Codecs & simulcast/SVC**
- https://www.webrtc-developers.com/comparison-of-webrtc-codecs-for-video-and-screen-sharing/
- https://www.gethopp.app/blog/screensharing-encoders-compared
- https://github.com/fippo/webrtc-explainers/blob/gh-pages/av1-screencontent/index.md
- https://github.com/w3c/webrtc-svc/blob/main/explainer.md
- https://bloggeek.me/webrtcglossary/svc/
- https://bloggeek.me/webrtcglossary/temporal-scalability/
- https://www.digitalsamba.com/blog/svc-vs-simulcast-in-webrtc
- https://issues.webrtc.org/issues/42223195
- https://antmedia.io/webrtc-browser-support/

**LiveKit**
- https://raw.githubusercontent.com/livekit/client-sdk-js/main/src/room/track/options.ts
- https://docs.livekit.io/home/client/tracks/advanced/
- https://docs.livekit.io/transport/media/subscribe/
- https://docs.livekit.io/transport/self-hosting/benchmark/
- https://docs.livekit.io/home/self-hosting/deployment/
- https://docs.livekit.io/deploy/admin/regions/endpoints/
- https://docs.livekit.io/home/client/tracks/encryption/
- https://livekit.com/pricing
- https://github.com/livekit/client-sdk-js/issues/1822
- https://github.com/livekit/livekit/issues/2811
- https://kb.livekit.io/articles/3859313029-configuring-the-client-sdk-for-optimal-video-quality

**Managed**
- https://developers.cloudflare.com/realtime/sfu/pricing/
- https://developers.cloudflare.com/realtime/sfu/simulcast/
- https://blog.cloudflare.com/cloudflare-calls-anycast-webrtc/
- https://blog.cloudflare.com/pt-br/expanding-to-25-plus-cities-in-brazil-pt-br/
- https://aws.amazon.com/ivs/pricing/
- https://docs.aws.amazon.com/ivs/latest/RealTimeUserGuide/rt-stream-ingest.html

**Hosting & networking**
- https://blogs.vultr.com/Vultr-Announces-Reduced-Bandwidth-Pricing-2-Tb-Of-Free-Monthly-Egress-Free-Ingress-And-Global-Pooling
- https://docs.vultr.com/support/platform/billing/what-is-the-bandwidth-overage-rate
- https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/
- https://heroctl.com/en/blog/hetzner-vs-digitalocean-vs-magalu-cloud
- https://ideas.digitalocean.com/infrastructure/p/datacenter-in-brazil
- https://aws-pricing.com/sa-east-1.html
- https://celloip.com/blog/webrtc-turn-server-production-guide/

**WHIP/WHEP & E2EE**
- https://www.forasoft.com/blog/article/whip-whep-replace-rtmp-live-streaming-2026
- https://www.forasoft.com/learn/video-streaming/articles-streaming/whep-webrtc-egress
- https://www.meetecho.com/blog/whip-whep/
- https://www.meetecho.com/blog/janus-e2ee-sframe/
- https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpScriptTransform
- https://www.forasoft.com/blog/article/webrtc-security-in-plain-language-495
