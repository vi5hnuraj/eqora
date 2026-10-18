// Direct browser → Arkiv reads (no backend in the loop), following the SDK's
// React integration pattern: a shared public client, TanStack Query on top.
import { createPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { addr, i32, str } from "@arkiv-network/sdk/attr";
import { and, eq, gt } from "@arkiv-network/sdk/query";
import { http, keccak256, toHex } from "viem";
import { listJournal, listLoans, listNotes, listLendEvents, getArkivStatus, getJournalEntry } from "./api.js";

export const TIRAMISU_RPC = "https://rpc.tiramisu.db-chain.testnet.arkiv.network";
export const TIRAMISU_WS = "wss://rpc.tiramisu.db-chain.testnet.arkiv.network";
export const EXPLORER = "https://tiramisu.explorer.arkiv.network";

// Collection metadata for the Explorer record browser.
export const ENTITY_KINDS = [
  { kind: "trade_journal", label: "Trade journal", desc: "Trade execution record", icon: "📊", tint: "#8b5cf6" },
  { kind: "loan_memo", label: "Loan memo", desc: "Open loan position", icon: "📄", tint: "#38bdf8" },
  { kind: "journal_note", label: "Journal note", desc: "User annotation", icon: "📝", tint: "#f59e0b" },
  { kind: "user_profile", label: "User profile", desc: "Profile information", icon: "👤", tint: "#34d399" },
  { kind: "leaderboard_entry", label: "Leaderboard entry", desc: "Ranking snapshot", icon: "🏆", tint: "#fbbf24" },
  { kind: "session_snapshot", label: "Session snapshot", desc: "Market session snapshot", icon: "📸", tint: "#f472b6" },
  { kind: "lend_event", label: "Lend event", desc: "Supply/borrow/repay/withdraw mirrored from Amoy", icon: "🏦", tint: "#22d3ee" },
];
export const KIND_META = Object.fromEntries(ENTITY_KINDS.map((m) => [m.kind, m]));

const num = (v) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));
const val = (attr) => attr?.value ?? attr;

export const arkivPublic = createPublicClient({
  chain: tiramisu,
  // The keyless RPC rate-limits (429). The SDK/viem default retries 3× per
  // request, which turns one 429 into a self-inflicted retry storm — we pace
  // and back off at the call sites instead, so transport retries stay off.
  transport: http(TIRAMISU_RPC, { retryCount: 0, timeout: 12_000 }),
});

// 429 detection — used to wait longer between retries instead of hammering.
const isRateLimited = (e) =>
  e?.status === 429 ||
  e?.statusCode === 429 ||
  /429|too many requests/i.test(String(e?.message || e?.details || ""));

export const entityUrl = (key) => `${EXPLORER}/entity/${key}`;
export const txUrl = (hash) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (a) => `${EXPLORER}/address/${a}`;

const READ_TIMEOUT_MS = 25_000;
const LIST_TIMEOUT_MS = 12_000;
function withTimeout(promise, ms = READ_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Arkiv read timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Last good full read — kept in localStorage so Explorer paints instantly
// while the live refetch runs in the background (public RPC stalls).
const CACHE_KEY = "eqora-arkiv-records-v1";
export function loadRecordsCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.rows)) return null;
    return parsed;
  } catch { return null; }
}
function saveRecordsCache(data) {
  try {
    // Cap the cache — only the newest 200 rows need to survive a reload.
    const slim = { ...data, rows: data.rows.slice(0, 200) };
    localStorage.setItem(CACHE_KEY, JSON.stringify(slim));
  } catch { /* quota — ignore */ }
}

export const hashNote = (text) => keccak256(toHex(text));

// Chain liveness for the status chip: getChainId + getBlockTiming + count.
export async function fetchArkivStatus() {
  try {
    const s = await getArkivStatus();
    if (s && s.chainId) {
      return {
        chainId: s.chainId,
        currentBlock: Number(s.currentBlock),
        blockDuration: Number(s.blockDuration || 2),
        entityCount: Number(s.entityCount || 0),
        explorer: s.explorer || EXPLORER,
      };
    }
  } catch {
    // fallback to direct RPC only if backend is unreachable
  }
  const [chainId, timing, entityCount] = await withTimeout(
    Promise.all([
      arkivPublic.getChainId(),
      arkivPublic.getBlockTiming(),
      arkivPublic.getEntityCount(),
    ])
  );
  return {
    chainId,
    currentBlock: Number(timing.currentBlock),
    blockDuration: Number(timing.blockDuration),
    entityCount: Number(entityCount),
    explorer: EXPLORER,
  };
}

// One entity straight from the browser — used by the verify panel.
export async function fetchEntityDirect(key) {
  try {
    const j = await getJournalEntry(key);
    if (j && j.key) return j;
  } catch {
    // fallback to direct RPC
  }
  const entity = await withTimeout(arkivPublic.getEntity(key));
  return entity;
}

// All journal_note rows for a user, read browser-side and grouped by trade.
export async function fetchNotesDirect(user) {
  try {
    const res = await listNotes({ user, limit: 100 });
    if (res?.entities) {
      return res.entities.map((entity) => {
        let text = "";
        try {
          text = typeof entity.payload === "string" ? entity.payload : (entity.payload?.text ?? entity.payload?.note ?? "");
        } catch {
          text = "";
        }
        const a = entity.attributes ?? {};
        return {
          key: entity.key,
          owner: entity.owner,
          createdAt: Number(entity.createdAt),
          createdMs: num(a.created_ms?.value ?? a.created_ms),
          expiresAt: Number(entity.expiresAt),
          tradeRef: String(a.trade_ref?.value ?? a.trade_ref ?? ""),
          textHash: String(a.text_hash?.value ?? a.text_hash ?? ""),
          text,
        };
      });
    }
  } catch {
    // fallback to direct SDK
  }
  const page = await withTimeout(
    arkivPublic
      .select({ key: true, owner: true, createdAt: true, expiresAt: true, attributes: true, payload: true })
      .where(and(eq("kind", str("journal_note")), eq("user", addr(user))))
      .limit(200)
      .fetch()
  );
  return page.entities.map((entity) => {
    let text = "";
    try {
      text = entity.toText();
    } catch {
      text = "";
    }
    return {
      key: entity.key,
      owner: entity.owner,
      createdAt: Number(entity.createdAt),
      createdMs: num(entity.attributes?.created_ms?.value),
      expiresAt: Number(entity.expiresAt),
      tradeRef: String(entity.attributes?.trade_ref?.value ?? ""),
      textHash: String(entity.attributes?.text_hash?.value ?? ""),
      text,
    };
  });
}

// The trader's own entities under ownedBy() — proves post-claim ownership
// straight from the browser.
export async function fetchOwnedTradesDirect(owner) {
  const page = await withTimeout(
    arkivPublic
      .select({ key: true, owner: true, creator: true, attributes: true })
      .where(eq("kind", str("trade_journal")))
      .ownedBy(owner)
      .limit(50)
      .fetch()
  );
  return page.entities.map((e) => ({ key: e.key, owner: e.owner, creator: e.creator, pnl: Number(e.attributes?.pnl_bps?.value ?? 0) }));
}

// Win totals via gt() — the browser runs the same predicate the backend uses.
export async function fetchWinCountDirect(user) {
  try {
    const res = await listJournal({ user, minPnlBps: 1, limit: 100 });
    if (res?.entities) return res.entities.length;
  } catch {
    // fallback
  }
  try {
    const page = await withTimeout(
      arkivPublic
        .select({ key: true })
        .where(and(eq("kind", str("trade_journal")), eq("user", addr(user)), gt("pnl_bps", i32(0))))
        .limit(200)
        .fetch()
    );
    return page.entities.length;
  } catch {
    return 0;
  }
}

// CSV export via the builder's async iterator — walks every page, yields
// one entity at a time, right in the browser.
export async function* iterateJournals(user) {
  const builder = arkivPublic
    .select({ key: true, owner: true, createdAt: true, expiresAt: true, attributes: true, payload: true })
    .where(and(eq("kind", str("trade_journal")), eq("user", addr(user))))
    .limit(100);
  for await (const entity of builder) yield entity;
}

export async function exportJournalsCsv(user) {
  const rows = [
    ["key", "owner", "created_at", "symbol", "side", "size", "price", "pnl_bps", "trade_type", "leverage", "session", "note"],
  ];
  for await (const entity of iterateJournals(user)) {
    const a = entity.attributes ?? {};
    let note = "";
    try {
      note = String(entity.toJson()?.note ?? "").replace(/"/g, '""');
    } catch {
      note = "";
    }
    rows.push([
      entity.key ?? "",
      entity.owner ?? "",
      new Date(num(a.created_ms?.value) || Date.now()).toISOString(),
      String(a.symbol?.value ?? ""),
      String(a.side?.value ?? ""),
      String(a.size?.value ?? ""),
      String(a.price?.value ?? ""),
      String(a.pnl_bps?.value ?? ""),
      String(a.trade_type?.value ?? ""),
      String(a.leverage?.value ?? ""),
      String(a.session?.value ?? ""),
      note,
    ]);
  }
  return rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
}

// Tiny local hash check: bytes32 stored on Arkiv vs recomputed here.
export function verifyNoteHash(storedHash, text) {
  if (!storedHash) return false;
  return String(storedHash).toLowerCase() === hashNote(text).toLowerCase();
}

// ── Arkiv Explorer: all collections in one browser-direct pass ─────────────
function parseRecord(entity, meta) {
  const a = {};
  for (const [name, attr] of Object.entries(entity.attributes ?? {})) {
    a[name] = val(attr);
  }
  let payloadText = null;
  try {
    if (typeof entity.toText === "function") {
      payloadText = entity.toText();
    } else if (typeof entity.payload === "string") {
      payloadText = entity.payload;
    } else if (entity.payload && typeof entity.payload === "object") {
      payloadText = entity.payload.note || entity.payload.text || JSON.stringify(entity.payload);
    }
  } catch {
    payloadText = null;
  }
  const fl = entity.creationFlags || entity.flags;
  const flags = fl
    ? {
        readonly: Boolean(fl.readonly),
        permissionlessExtension: Boolean(fl.permissionlessExtension),
        raw: num(fl.raw ?? 0),
      }
    : null;
  return {
    key: entity.key,
    owner: entity.owner,
    creator: entity.creator ?? null,
    kind: meta.kind,
    meta,
    createdMs: num(a.created_ms) || (entity.createdAt ? entity.createdAt * 2000 : Date.now()),
    createdBlock: num(entity.createdAt),
    expiresAtBlock: num(entity.expiresAt),
    flags,
    attrs: a,
    payloadText,
  };
}

// All collections aggregated and sorted newest-first.
// Fetches through the backend API which holds the authenticated Arkiv access key,
// completely avoiding public testnet RPC anonymous 429 rate limits.
export async function fetchAllRecords() {
  const t0 = Date.now();
  try {
    const [j, l, n, le] = await Promise.all([
      listJournal({ limit: 60 }).catch(() => ({ entities: [] })),
      listLoans({ limit: 60 }).catch(() => ({ entities: [] })),
      listNotes({ limit: 60 }).catch(() => ({ entities: [] })),
      listLendEvents({ limit: 60 }).catch(() => ({ entities: [] })),
    ]);

    const rows = [];
    const pushEntities = (list, kind) => {
      const meta = KIND_META[kind] || { kind, label: kind };
      for (const e of list || []) {
        rows.push(parseRecord(e, meta));
      }
    };

    pushEntities(j?.entities, "trade_journal");
    pushEntities(l?.entities, "loan_memo");
    pushEntities(n?.entities, "journal_note");
    pushEntities(le?.entities, "lend_event");

    rows.sort((x, y) => (y.createdMs || 0) - (x.createdMs || 0));

    const result = {
      rows,
      currentBlock: j?.blockNumber || 0,
      blockDuration: 2,
      tookMs: Date.now() - t0,
      syncedAt: Date.now(),
      failedKinds: [],
      rateLimited: false,
    };

    if (rows.length > 0) saveRecordsCache(result);
    return result;
  } catch (err) {
    const cached = loadRecordsCache();
    if (cached?.rows?.length) return cached;
    return {
      rows: [],
      currentBlock: 0,
      blockDuration: 2,
      tookMs: Date.now() - t0,
      syncedAt: Date.now(),
      failedKinds: [],
      rateLimited: false,
    };
  }
}

// Lease math: blocks remaining → human days (Permanent → null).
export function expiresInDays(expiresAtBlock, currentBlock, blockDuration) {
  if (!expiresAtBlock || !currentBlock) return null;
  const blocks = expiresAtBlock - currentBlock;
  if (blocks <= 0) return -1;
  const days = (blocks * (blockDuration || 1)) / 86_400;
  // Permanent records carry a ~uint-max sentinel block, not a real expiry.
  return days > 36_500 ? null : days;
}

export const fmtDate = (ms) =>
  ms ? new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

export const fmtDaysLabel = (days) => {
  if (days == null) return "Never";
  if (days < 0) return "Expired";
  if (days >= 90) return `in ${Math.round(days)} days`;
  if (days < 1) return `in ${Math.max(1, Math.round(days * 24))}h`;
  return `in ${Math.round(days)} days`;
};

// Network diagnostics probes.
export async function probeHttp() {
  const t0 = Date.now();
  try {
    const s = await getArkivStatus();
    if (s && s.chainId) return Date.now() - t0;
  } catch {}
  try {
    await withTimeout(arkivPublic.getChainId(), 3000);
    return Date.now() - t0;
  } catch {
    return -1;
  }
}

export function probeWs(timeout = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let ws;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { ws?.close(); } catch { /* ignore */ }
      resolve({ ok, ms: Date.now() - t0 });
    };
    try {
      ws = new WebSocket(TIRAMISU_WS);
      ws.onopen = () => finish(true);
      ws.onerror = () => finish(false);
      ws.onclose = () => finish(false);
      setTimeout(() => finish(false), timeout);
    } catch {
      finish(false);
    }
  });
}
