// Smoke test for the local LiveKit dev server (infra/dev/docker-compose.yml).
// Mints a subscriber JWT with the dev credentials and asks LiveKit to validate
// it (/rtc/validate is the same pre-connect check livekit-client performs).
// Run: node infra/dev/smoke.mjs
import crypto from "node:crypto";

const KEY = "devkey"; // LiveKit --dev credentials, local only
const SECRET = "secret";
const URL_BASE = process.env.LIVEKIT_URL ?? "http://localhost:7880";

const b64u = (s) => Buffer.from(s).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = { alg: "HS256", typ: "JWT" };
const payload = {
  iss: KEY,
  sub: "smoke-test",
  jti: "smoke-test",
  nbf: now - 10,
  exp: now + 600,
  video: { room: "smoke", roomJoin: true, canSubscribe: true, canPublish: false },
};
const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
const sig = crypto.createHmac("sha256", SECRET).update(input).digest("base64url");
const token = `${input}.${sig}`;

const res = await fetch(`${URL_BASE}/rtc/validate?access_token=${token}`);
const body = await res.text();
if (res.ok) {
  console.log(`OK — LiveKit at ${URL_BASE} accepted the token (${res.status}: ${body})`);
} else {
  console.error(`FAIL — ${res.status}: ${body}`);
  process.exit(1);
}
