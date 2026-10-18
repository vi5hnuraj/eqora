import { API } from "./config.js";

async function json(path, options = {}) {
  // Abort if the backend (or the Arkiv node behind it) stalls, so the UI
  // shows an error instead of spinning forever. Mint waits for an Amoy
  // receipt, so that route gets a longer budget.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${API}${path}`, { ...options, signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("request timed out — node unreachable");
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export const getConfig = () => json("/api/config");
export const getHealth = () => json("/api/health");
export const getPrices = () => json("/api/prices");
export const getFx = () => json("/api/fx");
export const getCandles = (symbol, timeframe = "1d") =>
  json(`/api/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`);

export const listJournal = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  return json(`/api/journal?${q}`);
};

export const createJournal = (entry) =>
  json("/api/journal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });

export const getJournalEntry = (key) => json(`/api/journal/${encodeURIComponent(key)}`);

export const mintShares = (entry) =>
  json("/api/mint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
    timeoutMs: 45_000,
  });

export const listLoans = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  return json(`/api/loans?${q}`);
};

export const syncLoan = (memo) =>
  json("/api/loans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(memo),
  });

export const listLendEvents = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  return json(`/api/lend-events?${q}`);
};

export const createLendEvent = (ev) =>
  json("/api/lend-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ev),
  });

export const createSession = (snap) =>
  json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snap),
  });

export const getArkivStatus = () => json("/api/arkiv/status");

export const getLeaderboard = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  return json(`/api/leaderboard?${q}`);
};

export const claimJournal = (keys, newOwner) =>
  json("/api/journal/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys, newOwner }),
  });

export const listNotes = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  return json(`/api/notes?${q}`);
};

export const createNote = (note) =>
  json("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(note),
  });

export const patchNote = (key, text) =>
  json(`/api/notes/${key}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

export const deleteNote = (key) => json(`/api/notes/${key}`, { method: "DELETE" });

export const getProfile = (user) => json(`/api/profile?user=${user}`);

export const saveProfile = (profile) =>
  json("/api/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });

export const patchLoan = (key, patch) =>
  json(`/api/loans/${key}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });

// Server-Sent Events bridge over the backend's Arkiv watchEntityEvents stream.
export function subscribeJournal(onEvent, onError) {
  const source = new EventSource(`${API}/api/events`);
  source.addEventListener("journal", (e) => {
    try { onEvent(JSON.parse(e.data)); } catch { /* ignore malformed */ }
  });
  source.addEventListener("error", () => onError?.(new Error("event stream disconnected")));
  return () => source.close();
}
