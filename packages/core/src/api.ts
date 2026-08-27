import type { CreateSessionResponse } from "./generated/CreateSessionResponse";
import type { ViewerTokenResponse } from "./generated/ViewerTokenResponse";

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

/** Create a session. Pass `name` for a vanity id (/s/<name>); a taken name
 * throws NameTakenError so the UI can ask for another. */
export async function createSession(
  name?: string,
  baseUrl = "",
): Promise<CreateSessionResponse> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: name || null }),
  });
  if (res.status === 409) throw new NameTakenError(await res.text());
  if (res.status === 400) throw new Error(await res.text());
  if (!res.ok) throw new Error(`createSession failed: HTTP ${res.status}`);
  return res.json();
}

export async function fetchViewerToken(
  sessionId: string,
  baseUrl = "",
): Promise<ViewerTokenResponse> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/token`);
  if (res.status === 404) throw new StreamNotFoundError();
  if (!res.ok) throw new Error(`fetchViewerToken failed: HTTP ${res.status}`);
  return res.json();
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
