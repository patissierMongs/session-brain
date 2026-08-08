export interface SessionSummary {
  id: string; project: string; project_name: string; title: string;
  first_ts: string; last_ts: string;
  user_msgs: number; assistant_msgs: number; subagents: number;
}
export interface SessionLink {
  uuid: string; parent_uuid: string | null; line_no: number;
  role: string; has_content: boolean;
}
export interface SessionMessage { role: string; ts: string; content: string; kind: string; }
export interface SessionData {
  meta: Record<string, any>;
  links: SessionLink[];
  messages: Record<string, SessionMessage>;
}
export interface SearchHit {
  session_id: string; project: string; title: string;
  role: string; ts: string; snippet: string; kind: string;
}

async function j<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}
export const api = {
  sessions: () => j<{ sessions: SessionSummary[] }>("/api/sessions"),
  session: (id: string) => j<SessionData>("/api/session/" + encodeURIComponent(id)),
  search: (q: string, semantic: boolean, limit = 20) =>
    j<{ hits: SearchHit[]; scan_total: number; semantic_note: string | null }>(
      `/api/search?q=${encodeURIComponent(q)}&semantic=${semantic ? 1 : 0}&limit=${limit}`),
};
