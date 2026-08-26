import type { CreateSessionResponse } from "./generated/CreateSessionResponse";
import type { ViewerTokenResponse } from "./generated/ViewerTokenResponse";

export async function createSession(baseUrl = ""): Promise<CreateSessionResponse> {
  const res = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
  if (!res.ok) throw new Error(`createSession failed: HTTP ${res.status}`);
  return res.json();
}

export async function fetchViewerToken(
  sessionId: string,
  baseUrl = "",
): Promise<ViewerTokenResponse> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/token`);
  if (!res.ok) throw new Error(`fetchViewerToken failed: HTTP ${res.status}`);
  return res.json();
}
