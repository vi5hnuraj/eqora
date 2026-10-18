import http from "node:http";
import { config } from "./config.js";
import {
  batchClose,
  claimEntities,
  createNote,
  createSessionSnapshot,
  createTradeJournal,
  deleteNote,
  createLendEvent,
  getArkivStatus,
  getLeaderboard,
  getTradeJournal,
  listLendEvents,
  listLoanMemos,
  listNotes,
  listProfiles,
  listSessions,
  listTradeJournals,
  patchLoanMemo,
  patchNote,
  saveProfile,
  syncLoanMemo,
  watchJournalEvents,
} from "./arkiv.js";
import { SYMBOLS, marketOpenIST, readOnChainPrices, fetchCandles, mintShares } from "./market.js";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function json(res, status, body) {
  const data = JSON.stringify(body, (_key, value) =>
    typeof value === "bigint" ? Number(value) : value
  );
  res.writeHead(status, { ...headers, "Content-Type": "application/json" });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function statusFor(error) {
  const name = error?.constructor?.name ?? "";
  if (/EntityMutation/.test(name)) return 502;
  if (/NoEntityFound|NoMoreResults/.test(name)) return 404;
  if (/Invalid|Missing|Unknown|TooMany|Untyped|Conflict|QueryError|UnsupportedOperator|EmptyPatch|NoRandomSource/.test(name)) return 400;
  return 500;
}

// USD/INR display rate — cached 1h, purely for the display toggle.
// Settlement/accounting stays in INR/mINR; this never touches contracts.
let fxCache = { rate: null, at: 0 };
async function getUsdInr() {
  if (fxCache.rate && Date.now() - fxCache.at < 3_600_000) {
    return { rate: fxCache.rate, at: new Date(fxCache.at).toISOString(), source: "cache" };
  }
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    const inr = Number(body?.rates?.INR);
    if (Number.isFinite(inr) && inr > 0) {
      fxCache = { rate: inr, at: Date.now() };
      return { rate: inr, at: new Date(fxCache.at).toISOString(), source: "live" };
    }
    throw new Error("no INR in payload");
  } catch (e) {
    if (fxCache.rate) {
      return { rate: fxCache.rate, at: new Date(fxCache.at).toISOString(), source: "stale-cache" };
    }
    // last-resort fallback — never 500 the toggle
    return { rate: 83.5, at: null, source: "fallback" };
  }
}

// Viem/Arkiv errors embed the request URL — which contains the access key in
// the path. Never ship that to the browser.
function errMsg(error) {
  const msg = error?.message ?? String(error);
  return msg.replace(/ark_live_[A-Za-z0-9_\-]+/g, "ark_live_…(redacted)");
}

function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

const subscribers = new Set();
let unwatch = null;

function ensureWatcher() {
  if (unwatch) return;
  unwatch = watchJournalEvents({
    onEntity: (event) => {
      const frame = `event: journal\ndata: ${JSON.stringify(event)}\n\n`;
      for (const res of subscribers) res.write(frame);
    },
    onError: (error) => {
      const frame = `event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`;
      for (const res of subscribers) res.write(frame);
    },
  });
}

function broadcastHello(res) {
  res.write(
    `event: hello\ndata: ${JSON.stringify({
      chain: "tiramisu",
      kinds: ["trade_journal", "loan_memo", "journal_note", "user_profile", "leaderboard_entry"],
      at: Date.now(),
    })}\n\n`
  );
}

async function handle(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (route === "GET /api/health") {
    return json(res, 200, {
      ok: true,
      privateKeyLoaded: Boolean(config.privateKey),
      deployment: config.deployment?.network ?? null,
      market: marketOpenIST(),
    });
  }

  if (route === "GET /api/config") {
    const dep = config.deployment;
    return json(res, 200, {
      chainId: dep?.chainId ?? null,
      deployer: dep?.deployer ?? null,
      contracts: dep?.contracts ?? null,
      symbols: Object.keys(SYMBOLS),
      tiramisuChainId: 7738577,
    });
  }

  if (route === "GET /api/prices") {
    try {
      const prices = await readOnChainPrices();
      return json(res, 200, { market: marketOpenIST(), prices });
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "GET /api/candles") {
    try {
      const data = await fetchCandles(
        url.searchParams.get("symbol") || "IND-RELIANCE",
        url.searchParams.get("timeframe") || "1d"
      );
      return json(res, 200, data);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  // USD/INR display rate — cached, purely for the display toggle.
  // Settlement/accounting stays in INR/mINR; this never touches contracts.
  if (route === "GET /api/fx") {
    return json(res, 200, await getUsdInr());
  }

  if (route === "GET /api/journal") {
    try {
      const page = await listTradeJournals({
        user: url.searchParams.get("user") ?? undefined,
        symbol: url.searchParams.get("symbol") ?? undefined,
        symbols: url.searchParams.get("symbols") ?? undefined,
        symbolMode: url.searchParams.get("symbolMode") ?? undefined,
        session: url.searchParams.get("session") ?? undefined,
        sessionPrefix: url.searchParams.get("sessionPrefix") ?? undefined,
        minPnlBps: url.searchParams.get("minPnlBps") ?? undefined,
        maxPnlBps: url.searchParams.get("maxPnlBps") ?? undefined,
        outcome: url.searchParams.get("outcome") ?? undefined,
        side: url.searchParams.get("side") ?? undefined,
        excludeSide: url.searchParams.get("excludeSide") ?? undefined,
        typeFilter: url.searchParams.get("typeFilter") ?? undefined,
        typeofFilter: url.searchParams.get("typeofFilter") ?? undefined,
        levOnly: url.searchParams.get("levOnly") ?? undefined,
        expiringSoon: url.searchParams.get("expiringSoon") ?? undefined,
        sinceMs: url.searchParams.get("sinceMs") ?? undefined,
        creator: url.searchParams.get("creator") ?? undefined,
        owner: url.searchParams.get("owner") ?? undefined,
        limit: url.searchParams.get("limit") ?? 50,
        cursor: url.searchParams.get("cursor") ?? undefined,
      });
      return json(res, 200, page);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "POST /api/journal/claim") {
    try {
      const body = await readBody(req);
      if (!isAddress(body.newOwner)) return json(res, 400, { error: "newOwner must be a 0x address" });
      const result = await claimEntities({ keys: body.keys, newOwner: body.newOwner });
      return json(res, 201, result);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "POST /api/journal") {
    try {
      const body = await readBody(req);
      if (!isAddress(body.user)) return json(res, 400, { error: "user must be a 0x address" });
      const result = await createTradeJournal(body);
      return json(res, 201, result);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "POST /api/mint") {
    try {
      const body = await readBody(req);
      if (!isAddress(body.user)) return json(res, 400, { error: "user must be a 0x address" });
      if (!body.symbol || !SYMBOLS[body.symbol]) return json(res, 400, { error: "unknown symbol" });
      const shares = Number(body.shares);
      if (!Number.isFinite(shares) || shares <= 0 || shares > 10_000) {
        return json(res, 400, { error: "shares must be 0 < shares ≤ 10000" });
      }
      const result = await mintShares(body.user, body.symbol, shares);
      return json(res, 201, result);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "POST /api/journal/batch") {
    try {
      const body = await readBody(req);
      if (body.trade && !isAddress(body.trade.user)) {
        return json(res, 400, { error: "trade.user must be a 0x address" });
      }
      const result = await batchClose(body);
      return json(res, 201, result);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  const journalKey = url.pathname.match(/^\/api\/journal\/(0x[0-9a-fA-F]{64})$/);
  if (req.method === "GET" && journalKey) {
    try {
      const entity = await getTradeJournal(journalKey[1]);
      return json(res, 200, entity);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "GET /api/loans") {
    try {
      const page = await listLoanMemos({
        user: url.searchParams.get("user") ?? undefined,
        healthFactorBelow: url.searchParams.get("healthFactorBelow") ?? undefined,
        limit: url.searchParams.get("limit") ?? 50,
        cursor: url.searchParams.get("cursor") ?? undefined,
      });
      return json(res, 200, page);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "POST /api/loans") {
    try {
      const body = await readBody(req);
      if (!isAddress(body.user)) return json(res, 400, { error: "user must be a 0x address" });
      const result = await syncLoanMemo(body);
      return json(res, 201, result);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "GET /api/lend-events") {
    try {
      const page = await listLendEvents({
        user: url.searchParams.get("user") ?? undefined,
        limit: url.searchParams.get("limit") ?? 50,
      });
      return json(res, 200, page);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "POST /api/lend-events") {
    try {
      const body = await readBody(req);
      if (!isAddress(body.user)) return json(res, 400, { error: "user must be a 0x address" });
      const result = await createLendEvent(body);
      return json(res, 201, result);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "GET /api/sessions") {
    try {
      const page = await listSessions({
        symbol: url.searchParams.get("symbol") ?? undefined,
        limit: url.searchParams.get("limit") ?? 20,
        cursor: url.searchParams.get("cursor") ?? undefined,
      });
      return json(res, 200, page);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "POST /api/sessions") {
    try {
      const body = await readBody(req);
      const result = await createSessionSnapshot(body);
      return json(res, 201, result);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "GET /api/notes") {
    try {
      const page = await listNotes({
        user: url.searchParams.get("user") ?? undefined,
        tradeRef: url.searchParams.get("tradeRef") ?? undefined,
        limit: url.searchParams.get("limit") ?? 100,
        cursor: url.searchParams.get("cursor") ?? undefined,
      });
      return json(res, 200, page);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "POST /api/notes") {
    try {
      const body = await readBody(req);
      if (!isAddress(body.user)) return json(res, 400, { error: "user must be a 0x address" });
      const result = await createNote({
        user: body.user,
        tradeRef: body.tradeRef,
        text: body.text,
        claim: Boolean(body.claim),
      });
      return json(res, 201, result);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  const noteKey = url.pathname.match(/^\/api\/notes\/(0x[0-9a-fA-F]{64})$/);
  if (req.method === "PATCH" && noteKey) {
    try {
      const body = await readBody(req);
      const result = await patchNote(noteKey[1], body.text);
      return json(res, 200, result);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }
  if (req.method === "DELETE" && noteKey) {
    try {
      const result = await deleteNote(noteKey[1]);
      return json(res, 200, result);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "GET /api/profile") {
    try {
      const page = await listProfiles({ user: url.searchParams.get("user") ?? undefined });
      return json(res, 200, page);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "PATCH /api/profile") {
    try {
      const body = await readBody(req);
      if (!isAddress(body.user)) return json(res, 400, { error: "user must be a 0x address" });
      const result = await saveProfile({
        user: body.user,
        handle: body.handle,
        claim: Boolean(body.claim),
      });
      return json(res, 200, result);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  const loanKey = url.pathname.match(/^\/api\/loans\/(0x[0-9a-fA-F]{64})$/);
  if (req.method === "PATCH" && loanKey) {
    try {
      const body = await readBody(req);
      const result = await patchLoanMemo(loanKey[1], body);
      return json(res, 200, result);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "GET /api/leaderboard") {
    try {
      const page = await getLeaderboard({
        limit: url.searchParams.get("limit") ?? 10,
        refresh: url.searchParams.get("refresh") === "1",
      });
      return json(res, 200, page);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "GET /api/arkiv/status") {
    try {
      const status = await getArkivStatus();
      return json(res, 200, status);
    } catch (error) {
      return json(res, statusFor(error), { error: errMsg(error) });
    }
  }

  if (route === "GET /api/events") {
    res.writeHead(200, {
      ...headers,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    broadcastHello(res);
    subscribers.add(res);
    ensureWatcher();
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(keepAlive);
      subscribers.delete(res);
      if (subscribers.size === 0 && unwatch) {
        unwatch();
        unwatch = null;
      }
    });
    return;
  }

  return json(res, 404, { error: "not found" });
}

export function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    handle(req, res, url).catch((error) => {
      if (!res.headersSent) json(res, 500, { error: errMsg(error) });
      else res.end();
    });
  });
  server.listen(config.port, () => {
    console.log(`[api] http://localhost:${config.port}`);
  });
  return server;
}
