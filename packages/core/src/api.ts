import type { CreateSessionResponse } from "./generated/CreateSessionResponse";
import type { KickResponse } from "./generated/KickResponse";
import type { NameAvailability } from "./generated/NameAvailability";
import type { ViewerTokenResponse } from "./generated/ViewerTokenResponse";

export type { CreateSessionResponse, KickResponse, NameAvailability };

export class NameTakenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameTakenError";
  }
}

export class StreamNotFoundError extends Error {
  constructor() {
    super("stream not found");
    this.name = "StreamNotFoundError";
  }
}

/** Closed stream: a PIN must be supplied. */
export class PinRequiredError extends Error {
  constructor() {
    super("pin required");
    this.name = "PinRequiredError";
  }
}

export class WrongPinError extends Error {
  constructor() {
    super("wrong pin");
    this.name = "WrongPinError";
  }
}

export class TooManyAttemptsError extends Error {
  constructor() {
    super("too many attempts — wait a minute");
    this.name = "TooManyAttemptsError";
  }
}

export interface CreateSessionOptions {
  /** Vanity id (/s/<name>); taken → NameTakenError. */
  name?: string;
  /** Public streams need no PIN. Default false (closed). */
  public?: boolean;
}

export async function createSession(
  opts: CreateSessionOptions = {},
  baseUrl = "",
): Promise<CreateSessionResponse> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: opts.name || null, public: opts.public ?? false }),
  });
  if (res.status === 409) throw new NameTakenError(await res.text());
  if (res.status === 400) throw new Error(await res.text());
  if (!res.ok) throw new Error(`createSession failed: HTTP ${res.status}`);
  return res.json();
}

export interface ViewerJoinOptions {
  pin?: string;
  name?: string;
}

export async function fetchViewerToken(
  sessionId: string,
  opts: ViewerJoinOptions = {},
  baseUrl = "",
): Promise<ViewerTokenResponse> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: opts.pin ?? null, name: opts.name ?? null }),
  });
  if (res.status === 404) throw new StreamNotFoundError();
  if (res.status === 401) throw new PinRequiredError();
  if (res.status === 403) throw new WrongPinError();
  if (res.status === 429) throw new TooManyAttemptsError();
  if (!res.ok) throw new Error(`fetchViewerToken failed: HTTP ${res.status}`);
  return res.json();
}

/** Kick a viewer's connection AND rotate the PIN (always). Returns the new
 * PIN so the publisher UI can surface it immediately. */
export async function kickViewer(
  sessionId: string,
  secret: string,
  identity: string,
  baseUrl = "",
): Promise<KickResponse> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/kick`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, identity }),
  });
  if (!res.ok) throw new Error(`kick failed: HTTP ${res.status}`);
  return res.json();
}

/** Read-only availability check for the live name indicator. Never claims. */
export async function checkName(
  name: string,
  baseUrl = "",
): Promise<NameAvailability> {
  try {
    const res = await fetch(`${baseUrl}/api/names/${encodeURIComponent(name)}`);
    if (!res.ok) return { valid: false, available: false };
    return await res.json();
  } catch {
    return { valid: false, available: false };
  }
}

/** Keeps a session marked live server-side. Returns a stop function. Runs in
 * whichever front-end holds the room (web page or Electron renderer). */
export function startHeartbeat(
  sessionId: string,
  secret: string,
  baseUrl = "",
): () => void {
  const beat = () => {
    void fetch(`${baseUrl}/api/sessions/${sessionId}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    }).catch(() => {});
  };
  beat();
  const timer = setInterval(beat, 5000);
  return () => clearInterval(timer);
}
