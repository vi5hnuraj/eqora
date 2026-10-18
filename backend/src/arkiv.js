import {
  ExpirationTime,
  createPublicClient,
  createWalletClient,
  jsonToPayload,
  stringToPayload,
} from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { addr, bool, bytes32, dec, i32, key, str, u256, u64 } from "@arkiv-network/sdk/attr";
import { and, eq, exists, gt, gte, hasType, lt, lte, ne, not, or, render, startsWith } from "@arkiv-network/sdk/query";
import { custom, http, keccak256, recoverMessageAddress, toHex, webSocket } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRequire } from "node:module";
import { config } from "./config.js";

// Installed SDK version — surfaced on /api/arkiv/status as live proof.
let SDK_VERSION = "0.8.x";
try {
  SDK_VERSION = createRequire(import.meta.url)("@arkiv-network/sdk/package.json").version;
} catch { /* keep range fallback */ }

const TIRAMISU_RPC = "https://rpc.tiramisu.db-chain.testnet.arkiv.network";
const TIRAMISU_WS = "wss://rpc.tiramisu.db-chain.testnet.arkiv.network";
export const EXPLORER_URL = "https://tiramisu.explorer.arkiv.network";

// The access key raises rate limits but carries a monthly cost-unit quota
// (docs.arkiv.network/start-here/access-keys). When it reports QUOTA_EXCEEDED
// every subsequent call falls back to the keyless public RPC (default rate
// limit, no quota) so the app keeps working — sticky per process, reported on
// /api/arkiv/status as `transport`.
const transportState = { via: config.tiramisuAccessKey ? "key" : "public" };

// Conditions that send traffic to the keyless public RPC: monthly quota
// exhausted (429 QUOTA_EXCEEDED) or key revoked/regenerated upstream (401/403 —
// viem would otherwise keep hammering a dead key).
function isQuotaError(error) {
  if (error?.status === 401 || error?.status === 403 || error?.status === 429) return true;
  if (error?.code === 401 || error?.code === 403 || error?.code === 429) return true;
  const text = `${error?.shortMessage ?? ""} ${error?.details ?? ""} ${error?.message ?? ""}`;
  return /QUOTA_EXCEEDED|quota exhausted|quota exceeded|Unauthorized|invalid.*key/i.test(text);
}

function transport() {
  // Factories: http()/custom() return `({chain}) => transport`. Resolve the
  // concrete request objects once, here, so the wrapper can dispatch.
  if (!config.tiramisuAccessKey) {
    return config.tiramisuRpcUrl ? http(config.tiramisuRpcUrl) : http();
  }
  const keyed = http(`${TIRAMISU_RPC}/${config.tiramisuAccessKey}`)({ chain: tiramisu });
  const plain = (config.tiramisuRpcUrl ? http(config.tiramisuRpcUrl) : http())({ chain: tiramisu });
  return custom({
    key: "arkiv-quota-fallback",
    name: "Arkiv HTTP (key → public fallback)",
    async request(args) {
      if (transportState.via === "key") {
        try {
          return await keyed.request(args);
        } catch (error) {
          if (!isQuotaError(error)) throw error;
          transportState.via = "fallback";
          console.warn(`[arkiv] access key rejected (status ${error?.status ?? error?.code ?? "429/quota"}) — falling back to the public RPC`);
        }
      }
      return plain.request(args);
    },
  });
}

function wsTransport() {
  if (config.tiramisuAccessKey) return webSocket(`${TIRAMISU_WS}/${config.tiramisuAccessKey}`);
  if (config.tiramisuRpcUrl) return webSocket(config.tiramisuRpcUrl);
  return webSocket(TIRAMISU_WS);
}

export const publicClient = createPublicClient({ chain: tiramisu, transport: transport() });

export function walletClient() {
  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY missing — copy backend/.env.example to backend/.env");
  }
  return createWalletClient({
    chain: tiramisu,
    transport: transport(),
    account: privateKeyToAccount(config.privateKey),
  });
}

export const ENTITY = {
  trade_journal: "trade_journal",
  loan_memo: "loan_memo",
  session_snapshot: "session_snapshot",
  journal_note: "journal_note",
  user_profile: "user_profile",
  leaderboard_entry: "leaderboard_entry",
  lend_event: "lend_event",
};

const YEAR_END = (() => {
  const now = new Date();
  return new Date(now.getFullYear(), 11, 31, 23, 59, 59);
})();

const EXPIRY = {
  trade_journal: ExpirationTime.fromDays(90),
  lend_event: ExpirationTime.fromDays(90),
  loan_memo: ExpirationTime.fromDays(7),
  session_snapshot: ExpirationTime.fromHours(48),
  journal_note: ExpirationTime.atDate(YEAR_END, { atLeast: ExpirationTime.fromDays(30) }),
  user_profile: ExpirationTime.permanent(),
  leaderboard_entry: ExpirationTime.fromDays(30),
};

// The journal outlives the app: readonly freezes the attrs/payload, while
// permissionlessExtension lets anyone (the trader included) pay to keep a
// record alive even if EQORA's backend disappears.
const TRADE_FLAGS = { readonly: true, permissionlessExtension: true };

// Arkiv's select()/getEntity() occasionally hangs on a stalled Tiramisu
// connection. Bound every read so the HTTP route times out cleanly instead
// of leaving the client spinning forever (the bug seen in demos).
// 25s default: on the keyless public RPC, viem's 429 Retry-After backoff can
// push a read past 12s. Override with ARKIV_READ_TIMEOUT_MS.
const READ_TIMEOUT_MS = Number(process.env.ARKIV_READ_TIMEOUT_MS || 25_000);

function withTimeout(promise, ms = READ_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Arkiv read timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function serializeEntity(entity) {
  const attributes = {};
  const safeIntMax = BigInt(Number.MAX_SAFE_INTEGER);
  for (const [name, value] of Object.entries(entity.attributes ?? {})) {
    const v = value.value;
    // u256 wei amounts exceed Number precision — the JSON bigint→Number
    // replacer would silently round them, so keep them as decimal strings.
    attributes[name] =
      typeof v === "bigint" && (v > safeIntMax || v < -safeIntMax) ? v.toString() : v;
  }
  let payload = null;
  try {
    payload = entity.toJson ? entity.toJson() : null;
  } catch {
    try {
      payload = entity.toText ? entity.toText() : null;
    } catch {
      payload = null;
    }
  }
  const flags = entity.creationFlags
    ? {
        readonly: Boolean(entity.creationFlags.readonly),
        permissionlessExtension: Boolean(entity.creationFlags.permissionlessExtension),
        raw: Number(entity.creationFlags.raw ?? 0),
      }
    : null;
  return {
    key: entity.key,
    owner: entity.owner,
    creator: entity.creator,
    createdAt: Number(entity.createdAt),
    expiresAt: Number(entity.expiresAt),
    flags,
    attributes,
    payload,
  };
}

// Exact decimal-string → u256 wei conversion (no float drift).
export function toWeiUnits(value) {
  const raw = String(value ?? "0").trim();
  const negative = raw.startsWith("-");
  const [whole, frac = ""] = (negative ? raw.slice(1) : raw).split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  const wei = BigInt(whole || "0") * 10n ** 18n + BigInt(fracPadded || "0");
  return negative ? -wei : wei;
}

function nowMs() {
  return u64(BigInt(Date.now()));
}

function tradeAttributes(input) {
  const attrs = {
    kind: str(ENTITY.trade_journal),
    user: addr(input.user),
    symbol: str(input.symbol),
    side: str(input.side),
    size: dec(String(input.size)),
    price: dec(String(input.price)),
    pnl_bps: i32(Math.round(Number(input.pnlBps))),
    session: str(input.session),
    trade_type: str(input.tradeType || "spot"),
    size_wei: u256(toWeiUnits(input.size)),
    created_ms: nowMs(),
  };
  if (input.leverage) attrs.leverage = i32(Math.round(Number(input.leverage)));
  return attrs;
}

function tradePayload(input) {
  return jsonToPayload({
    note: input.note ?? "",
    chart: input.chart ?? null,
    tradeType: input.tradeType || "spot",
    leverage: input.leverage ?? null,
    recordedBy: "eqora-backend",
    // Wallet signature over the human-readable ticket (EIP-191 personal_sign).
    // Verified in createTradeJournal before anything is written.
    ...(input.signature
      ? { signature: input.signature, signedMessage: input.signedMessage ?? "" }
      : {}),
  });
}

function loanAttributes(input) {
  return {
    kind: str(ENTITY.loan_memo),
    user: addr(input.user),
    collateral_symbol: str(input.collateralSymbol),
    collateral_amount: dec(String(input.collateralAmount)),
    debt_minr: dec(String(input.debtMinr ?? input.debtMINR)),
    health_factor: dec(String(input.healthFactor)),
    status: str(input.status || "open"),
    created_ms: nowMs(),
  };
}

function loanPayload(input) {
  return jsonToPayload({
    pool: input.pool ?? null,
    openAt: input.openAt ?? Date.now(),
    recordedBy: "eqora-backend",
  });
}

function sessionAttributes(input) {
  const attrs = {
    kind: str(ENTITY.session_snapshot),
    symbol: str(input.symbol),
    price: dec(String(input.price)),
    market_open: bool(Boolean(input.marketOpen)),
    created_ms: nowMs(),
  };
  // A session snapshot can reference the trade entity minted in the same tx —
  // only possible because predictEntityKeys knows the key before the batch runs.
  if (input.openedTrade) attrs.opened_trade = key(input.openedTrade);
  return attrs;
}

function noteAttributes(input) {
  return {
    kind: str(ENTITY.journal_note),
    user: addr(input.user),
    trade_ref: key(input.tradeRef),
    text_hash: bytes32(keccak256(toHex(input.text))),
    created_ms: nowMs(),
  };
}

function profileAttributes(input) {
  return {
    kind: str(ENTITY.user_profile),
    user: addr(input.user),
    handle: str(input.handle),
    created_ms: nowMs(),
  };
}

function leaderboardAttributes(entry) {
  return {
    kind: str(ENTITY.leaderboard_entry),
    user: addr(entry.user),
    score_bps: i32(Math.round(Number(entry.scoreBps))),
    wins: i32(Math.round(Number(entry.wins))),
    trades: u64(BigInt(Math.round(Number(entry.trades)))),
    rank: i32(Math.round(Number(entry.rank))),
    updated_ms: nowMs(),
  };
}

// statusFor() maps constructor names matching /Invalid/ to 400.
class InvalidSignatureError extends Error {}

export async function createTradeJournal(input) {
  // A signed ticket must actually be signed by the claiming account —
  // recover the EIP-191 signer and reject any mismatch before writing.
  if (input.signature) {
    if (!input.signedMessage) throw new InvalidSignatureError("signedMessage is required with signature");
    let recovered;
    try {
      recovered = await recoverMessageAddress({
        message: input.signedMessage,
        signature: input.signature,
      });
    } catch {
      throw new InvalidSignatureError("invalid signature");
    }
    if (recovered.toLowerCase() !== String(input.user).toLowerCase()) {
      throw new InvalidSignatureError("signature does not match user address");
    }
  }
  const { entityKey, txHash, expiresAt } = await walletClient().createEntity({
    payload: tradePayload(input),
    contentType: "application/json",
    attributes: tradeAttributes(input),
    expires: EXPIRY.trade_journal,
    flags: TRADE_FLAGS,
  });
  return { entityKey, txHash, expiresAt: Number(expiresAt) };
}

// Legacy entities were written without a created_ms attribute; recover an
// approximate timestamp from the entity's creation block (2s Tiramisu blocks).
// Flagged createdEst so the UI can mark it with ≈.
async function backfillCreatedAt(entities) {
  const missing = entities.filter((e) => Number(e.attributes?.created_ms ?? 0) <= 0 && e.createdAt > 0);
  if (!missing.length) return entities;
  try {
    const timing = await withTimeout(publicClient.getBlockTiming());
    const durMs = Math.max(1, Number(timing.blockDuration)) * 1000;
    const current = Number(timing.currentBlock);
    const now = Date.now();
    for (const e of missing) {
      const age = Math.max(0, current - e.createdAt) * durMs;
      e.attributes = { ...(e.attributes ?? {}), created_ms: String(now - age) };
      e.createdEst = true;
    }
  } catch { /* leave created_ms absent; UI shows — */ }
  return entities;
}

export async function listTradeJournals({
  user,
  creator,
  symbol,
  symbols,
  symbolMode,
  session,
  sessionPrefix,
  minPnlBps,
  maxPnlBps,
  outcome,
  side,
  excludeSide,
  typeFilter,
  typeofFilter,
  levOnly,
  expiringSoon,
  sinceMs,
  owner,
  limit = 50,
  cursor,
} = {}) {
  const filters = [eq("kind", str(ENTITY.trade_journal))];
  const pairs = [];
  if (user) filters.push(eq("user", addr(user)));
  if (symbol) filters.push(eq("symbol", str(symbol)));
  if (symbols) {
    const list = String(symbols)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 1) filters.push(eq("symbol", str(list[0])));
    if (list.length > 1) {
      const eqs = list.map((s) => eq("symbol", str(s)));
      // symbolMode=all → AND (educational: one symbol per trade, so this
      // matches nothing — it demonstrates mutually-exclusive predicates)
      filters.push(symbolMode === "all" ? and(...eqs) : or(...eqs));
    }
  }
  if (session) filters.push(eq("session", str(session)));
  if (sessionPrefix) filters.push(startsWith("session", String(sessionPrefix)));
  if (minPnlBps !== undefined && minPnlBps !== null && minPnlBps !== "") {
    filters.push(gte("pnl_bps", i32(Math.round(Number(minPnlBps)))));
  }
  if (maxPnlBps !== undefined && maxPnlBps !== null && maxPnlBps !== "") {
    filters.push(lte("pnl_bps", i32(Math.round(Number(maxPnlBps)))));
  }
  if (outcome === "win") filters.push(gt("pnl_bps", i32(0)));
  if (outcome === "loss") filters.push(lt("pnl_bps", i32(0)));
  if (side) filters.push(eq("side", str(side)));
  // excludeSide / levOnly / typeofFilter prefer the SDK's ne/exists/hasType.
  // The Tiramisu node currently rejects all three (-32002 "type"), so each
  // also carries an equivalent fallback the node does accept; on that exact
  // error we retry once and report which fell back (surfaced in friction.md).
  const prefer = (exact, alt, name) => {
    filters.push(exact);
    pairs.push({ exact, alt, name });
  };
  if (excludeSide) prefer(ne("side", str(excludeSide)), not(eq("side", str(excludeSide))), "ne→not(eq)");
  if (typeFilter === "leverage" || levOnly) {
    prefer(exists("leverage"), gt("leverage", i32(0)), "exists→gt(0)");
  }
  if (typeFilter === "spot") {
    filters.push(not(eq("trade_type", str("leverage"))));
  }
  if (typeofFilter) {
    const [name, tag] = String(typeofFilter).split(":");
    if (!name || !tag) throw new InvalidFilterError("typeofFilter must be name:tag");
    const zero = TYPE_ZERO[tag];
    if (!zero) throw new InvalidFilterError(`no range probe for type tag: ${tag}`);
    prefer(hasType(name, tag), gt(name, zero), "hasType→gt(zero)");
  }
  if (sinceMs) filters.push(gte("created_ms", u64(BigInt(Number(sinceMs)))));
  if (expiringSoon) {
    const timing = await withTimeout(publicClient.getBlockTiming());
    const seconds = 7 * 24 * 3600;
    const blocks = Math.ceil(seconds / Math.max(1, Number(timing.blockDuration)));
    filters.push(lte("$expiresAt", u64(timing.currentBlock + BigInt(blocks))));
  }

  const selectAndLimit = (expression) => {
    let builder = publicClient
      .select({
        key: true,
        owner: true,
        creator: true,
        createdAt: true,
        expiresAt: true,
        creationFlags: true,
        attributes: true,
        payload: true,
      })
      .where(expression)
      .limit(Math.min(Number(limit) || 50, 200));
    if (creator) builder = builder.createdBy(creator);
    if (owner) builder = builder.ownedBy(owner);
    if (cursor) builder = builder.cursor(cursor);
    return builder;
  };

  let page;
  let expression = and(filters);
  try {
    page = await withTimeout(selectAndLimit(expression).fetch());
  } catch (error) {
    const isNodeGap =
      error?.kind === "type" && String(error?.code) === "-32002" && pairs.length > 0;
    if (!isNodeGap) throw error;
    const merged = filters.map(
      (f) => pairs.find((pair) => pair.exact === f)?.alt ?? f
    );
    expression = and(merged);
    page = await withTimeout(selectAndLimit(expression).fetch());
    return {
      entities: await backfillCreatedAt(page.entities.map(serializeEntity)),
      cursor: page.cursor ?? null,
      blockNumber: Number(page.blockNumber),
      hasNextPage: page.hasNextPage(),
      query: render(expression),
      nodeFallbacks: pairs.map((pair) => pair.name),
    };
  }
  return {
    entities: await backfillCreatedAt(page.entities.map(serializeEntity)),
    cursor: page.cursor ?? null,
    blockNumber: Number(page.blockNumber),
    hasNextPage: page.hasNextPage(),
    query: render(expression),
    nodeFallbacks: [],
  };
}

const TYPE_ZERO = {
  i32: i32(0),
  u64: u64(0n),
  u256: u256(0n),
  dec: dec("0"),
};

class InvalidFilterError extends Error {}

export async function getTradeJournal(key) {
  const entity = await withTimeout(publicClient.getEntity(key));
  return serializeEntity(entity);
}

export async function createLoanMemo(input) {
  const { entityKey, txHash, expiresAt } = await walletClient().createEntity({
    payload: loanPayload(input),
    contentType: "application/json",
    attributes: loanAttributes(input),
    expires: EXPIRY.loan_memo,
  });
  return { entityKey, txHash, expiresAt: Number(expiresAt) };
}

export async function listLoanMemos({ user, healthFactorBelow, status, limit = 50, cursor } = {}) {
  const filters = [eq("kind", str(ENTITY.loan_memo))];
  if (user) filters.push(eq("user", addr(user)));
  if (status) filters.push(eq("status", str(status)));
  if (healthFactorBelow !== undefined && healthFactorBelow !== null && healthFactorBelow !== "") {
    filters.push(lt("health_factor", dec(String(healthFactorBelow))));
  }
  const expression = and(filters);
  let builder = publicClient
    .select({
      key: true,
      owner: true,
      createdAt: true,
      expiresAt: true,
      attributes: true,
      payload: true,
    })
    .where(expression)
    .limit(Math.min(Number(limit) || 50, 200));
  if (cursor) builder = builder.cursor(cursor);
  const page = await withTimeout(builder.fetch());
  return {
    entities: page.entities.map(serializeEntity),
    cursor: page.cursor ?? null,
    blockNumber: Number(page.blockNumber),
    hasNextPage: page.hasNextPage(),
    query: render(expression),
  };
}

export async function syncLoanMemo(input) {
  const existing = await listLoanMemos({ user: input.user, limit: 100 });
  const match = existing.entities.find(
    (e) => e.attributes.collateral_symbol === input.collateralSymbol
  );
  const wallet = walletClient();
  if (!match) {
    const created = await createLoanMemo(input);
    return { action: "created", ...created };
  }
  const result = await wallet.executeBatch({
    patches: [{ entityKey: match.key, set: loanAttributes(input) }],
    extensions: [{ entityKey: match.key, expires: EXPIRY.loan_memo }],
  });
  return {
    action: "renewed",
    entityKey: String(match.key),
    txHash: result.txHash,
  };
}

// Direct patchEntity (not a batch) — flips a memo's lifecycle state.
export async function patchLoanMemo(key, patch) {
  const set = {};
  if (patch.status) set.status = str(patch.status);
  if (patch.healthFactor !== undefined) set.health_factor = dec(String(patch.healthFactor));
  if (patch.debtMinr !== undefined) set.debt_minr = dec(String(patch.debtMinr));
  if (Object.keys(set).length === 0) throw new InvalidFilterError("nothing to patch");
  const { txHash } = await walletClient().patchEntity({ entityKey: key, set });
  return { entityKey: key, txHash };
}

export async function extendLoanMemo(key) {
  const { txHash, expiresAt } = await walletClient().extendEntity({
    entityKey: key,
    expires: EXPIRY.loan_memo,
  });
  return { entityKey: key, txHash, expiresAt: Number(expiresAt) };
}

export async function createSessionSnapshot(input) {
  const { entityKey, txHash, expiresAt } = await walletClient().createEntity({
    payload: jsonToPayload({ recordedBy: "eqora-backend", at: new Date().toISOString() }),
    contentType: "application/json",
    attributes: sessionAttributes(input),
    expires: EXPIRY.session_snapshot,
  });
  return { entityKey, txHash, expiresAt: Number(expiresAt) };
}

export async function batchClose({ trade, loanMemo, session }) {
  const creates = [];
  const patches = [];
  const extensions = [];
  let sessionInput = session;
  if (trade) {
    let linkedCreate = null;
    if (session) {
      // Predict the trade's key (carrying its salt into the create) so the
      // session snapshot created later in the same batch can point at it.
      try {
        const [predicted] = await withTimeout(
          publicClient.predictEntityKeys({ owner: walletClient().account.address, count: 1 })
        );
        sessionInput = { ...session, openedTrade: predicted.key };
        linkedCreate = { salt: predicted.salt, predictedKey: String(predicted.key) };
      } catch {
        sessionInput = session;
      }
    }
    const tradeCreate = {
      payload: tradePayload(trade),
      contentType: "application/json",
      attributes: tradeAttributes(trade),
      expires: EXPIRY.trade_journal,
      flags: TRADE_FLAGS,
    };
    if (linkedCreate) tradeCreate.salt = linkedCreate.salt;
    creates.push(tradeCreate);
  }
  if (sessionInput) {
    creates.push({
      payload: jsonToPayload({ recordedBy: "eqora-backend", at: new Date().toISOString() }),
      contentType: "application/json",
      attributes: sessionAttributes(sessionInput),
      expires: EXPIRY.session_snapshot,
    });
  }
  if (loanMemo) {
    if (loanMemo.key) {
      patches.push({ entityKey: loanMemo.key, set: loanAttributes(loanMemo) });
      extensions.push({ entityKey: loanMemo.key, expires: EXPIRY.loan_memo });
    } else {
      creates.push({
        payload: loanPayload(loanMemo),
        contentType: "application/json",
        attributes: loanAttributes(loanMemo),
        expires: EXPIRY.loan_memo,
      });
    }
  }
  const result = await walletClient().executeBatch({ creates, patches, extensions });
  return {
    txHash: result.txHash,
    createdEntities: (result.createdEntities ?? []).map((k) => String(k)),
    patchedEntities: (result.patchedEntities ?? []).map((k) => String(k)),
    extendedEntities: (result.extendedEntities ?? []).map((k) => String(k)),
    openedTrade: sessionInput?.openedTrade ? String(sessionInput.openedTrade) : null,
  };
}

export async function listSessions({ symbol, limit = 20, cursor } = {}) {
  const filters = [eq("kind", str(ENTITY.session_snapshot))];
  if (symbol) filters.push(eq("symbol", str(symbol)));
  let builder = publicClient
    .select({ key: true, createdAt: true, expiresAt: true, attributes: true })
    .where(and(filters))
    .limit(Math.min(Number(limit) || 20, 200));
  if (cursor) builder = builder.cursor(cursor);
  const page = await withTimeout(builder.fetch());
  return {
    entities: page.entities.map(serializeEntity),
    cursor: page.cursor ?? null,
    hasNextPage: page.hasNextPage(),
  };
}

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

// Claim: hand entities from the service wallet to the trader, in one batch.
// After this the trader owns them — queryable with ownedBy() and deletable
// by their own key, while creator stays the service wallet forever. Keys the
// service wallet does not own are skipped; transfers to the signer itself
// are a no-op (the engine rejects "already owned by that account").
export async function claimEntities({ keys, newOwner }) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new InvalidFilterError("keys must be a non-empty array");
  }
  if (!keys.every((k) => HEX_KEY.test(String(k)))) throw new InvalidFilterError("bad entity key");
  const wallet = walletClient();
  const signer = wallet.account.address.toLowerCase();
  const target = String(newOwner).toLowerCase();
  if (target === signer) {
    return { txHash: null, ownershipChanges: [], newOwner, alreadyOwned: keys.length };
  }
  const ownershipChanges = keys.map((k) => ({ entityKey: String(k), newOwner }));
  const result = await wallet.executeBatch({ ownershipChanges });
  return {
    txHash: result.txHash,
    ownershipChanges: (result.ownershipChanges ?? []).map((k) => String(k)),
    newOwner,
  };
}

// Standalone changeOwnership (outside a batch) — used to hand a throwaway
// entity to another account, exercising the direct wallet action. signerKey
// lets a NON-service owner sign (a smoke throwaway handing its entity back so
// the same run can still delete it — ownership gates deletion on Arkiv).
export async function transferEntity({ key, newOwner, signerKey }) {
  if (!HEX_KEY.test(String(key))) throw new InvalidFilterError("bad entity key");
  if (!isHexAddress(newOwner)) throw new InvalidFilterError("newOwner must be a 0x address");
  const client = signerKey
    ? createWalletClient({
        chain: tiramisu,
        transport: transport(),
        account: privateKeyToAccount(String(signerKey)),
      })
    : walletClient();
  const { txHash } = await client.changeOwnership({ entityKey: key, newOwner });
  return { entityKey: key, newOwner, txHash };
}

function isHexAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export async function listNotes({ user, tradeRef, limit = 100, cursor } = {}) {
  const filters = [eq("kind", str(ENTITY.journal_note))];
  if (user) filters.push(eq("user", addr(user)));
  if (tradeRef) filters.push(eq("trade_ref", key(tradeRef)));
  const expression = and(filters);
  let builder = publicClient
    .select({ key: true, owner: true, creator: true, createdAt: true, expiresAt: true, attributes: true, payload: true })
    .where(expression)
    .limit(Math.min(Number(limit) || 100, 200));
  if (cursor) builder = builder.cursor(cursor);
  const page = await withTimeout(builder.fetch());
  return {
    entities: page.entities.map(serializeEntity),
    cursor: page.cursor ?? null,
    hasNextPage: page.hasNextPage(),
    query: render(expression),
  };
}

// Note lifecycle. claim=true uses predictEntityKeys + a fixed salt so the
// key is known before minting — the same tx can then transfer ownership to
// the trader (the documented "reference an entity created in this batch"
// pattern).
export async function createNote({ user, tradeRef, text, claim = false }) {
  if (!HEX_KEY.test(String(tradeRef))) throw new InvalidFilterError("tradeRef must be a 32-byte key");
  const body = String(text ?? "").slice(0, 500);
  if (!body.trim()) throw new InvalidFilterError("note text required");
  const wallet = walletClient();
  const params = {
    payload: stringToPayload(body),
    contentType: "text/plain",
    attributes: noteAttributes({ user, tradeRef, text: body }),
    expires: EXPIRY.journal_note,
  };
  if (!claim) {
    const { entityKey, txHash, expiresAt } = await wallet.createEntity(params);
    return { entityKey, txHash, expiresAt: Number(expiresAt), owner: wallet.account.address, claimed: false };
  }
  const [predicted] = await withTimeout(
    publicClient.predictEntityKeys({ owner: wallet.account.address, count: 1 })
  );
  params.salt = predicted.salt;
  const target = String(user).toLowerCase();
  const selfOwned = target === wallet.account.address.toLowerCase();
  const ownershipChanges = selfOwned
    ? []
    : [{ entityKey: predicted.key, newOwner: user }];
  const result = await wallet.executeBatch({ creates: [params], ownershipChanges });
  const minted = String((result.createdEntities ?? [])[0] ?? predicted.key);
  return {
    entityKey: minted,
    txHash: result.txHash,
    owner: selfOwned ? wallet.account.address : user,
    claimed: minted === String(predicted.key),
    predictedKey: String(predicted.key),
    alreadyOwner: selfOwned,
  };
}

export async function patchNote(key, text) {
  const body = String(text ?? "").slice(0, 500);
  if (!body.trim()) throw new InvalidFilterError("note text required");
  const { txHash } = await walletClient().patchEntity({
    entityKey: key,
    payload: stringToPayload(body),
    contentType: "text/plain",
    set: { text_hash: bytes32(keccak256(toHex(body))) },
  });
  return { entityKey: key, txHash };
}

// ── lend_event: every pool operation mirrored onto Tiramisu ───────────────
// supply / withdraw / borrow / repay / collateral-toggle execute as Amoy
// transactions (money-math lives there); each one is also written here as an
// immutable event so the Arkiv journal covers lending, not just trades.
const LEND_OPS = new Set(["supply", "withdraw", "borrow", "repay", "toggle"]);

function lendEventAttributes(input) {
  let amountWei = 0n;
  try { amountWei = BigInt(String(input.amountWei ?? "0")); } catch { amountWei = 0n; }
  const attrs = {
    kind: str(ENTITY.lend_event),
    user: addr(input.user),
    op: str(String(input.op)),
    symbol: str(String(input.symbol || "mINR")),
    amount: str(String(input.amount ?? "0")),
    amount_wei: u256(amountWei),
    tx: str(String(input.txHash ?? "")),
    created_ms: nowMs(),
  };
  if (String(input.op) === "toggle") attrs.collateral_on = bool(Boolean(input.enabled));
  return attrs;
}

export async function createLendEvent(input) {
  if (!LEND_OPS.has(String(input.op))) {
    throw new InvalidFilterError(`unknown lend op: ${input.op}`);
  }
  const { entityKey, txHash, expiresAt } = await walletClient().createEntity({
    payload: jsonToPayload({
      op: String(input.op),
      symbol: String(input.symbol ?? ""),
      amount: String(input.amount ?? "0"),
      txHash: String(input.txHash ?? ""),
      chain: "polygon-amoy-80002",
      recordedBy: "eqora-backend",
    }),
    contentType: "application/json",
    attributes: lendEventAttributes(input),
    expires: EXPIRY.lend_event,
    flags: TRADE_FLAGS,
  });
  return { entityKey, txHash, expiresAt: Number(expiresAt) };
}

export async function listLendEvents({ user, limit = 50 } = {}) {
  const filters = [eq("kind", str(ENTITY.lend_event))];
  if (user) filters.push(eq("user", addr(user)));
  const page = await withTimeout(
    publicClient
      .select({ key: true, owner: true, createdAt: true, expiresAt: true, creationFlags: true, attributes: true })
      .where(and(filters))
      .limit(Math.min(Number(limit) || 50, 200))
      .fetch()
  );
  return { entities: page.entities.map(serializeEntity) };
}

export async function deleteNote(key) {
  if (!HEX_KEY.test(String(key))) throw new InvalidFilterError("bad entity key");
  const { txHash } = await walletClient().deleteEntity({ entityKey: key });
  return { entityKey: key, txHash, deleted: true };
}

export async function listProfiles({ user, limit = 20 } = {}) {
  const filters = [eq("kind", str(ENTITY.user_profile))];
  if (user) filters.push(eq("user", addr(user)));
  const page = await withTimeout(
    publicClient
      .select({ key: true, owner: true, createdAt: true, expiresAt: true, creationFlags: true, attributes: true })
      .where(and(filters))
      .limit(Math.min(Number(limit) || 20, 200))
      .fetch()
  );
  return { entities: page.entities.map(serializeEntity) };
}

// Profile create-or-update. claim=true creates it already owned by the
// trader (predictEntityKeys + ownershipChanges in one batch).
export async function saveProfile({ user, handle, claim = false }) {
  const name = String(handle ?? "").trim().slice(0, 24);
  if (!name) throw new InvalidFilterError("handle required");
  const existing = await listProfiles({ user });
  const profile = existing.entities[0];
  const wallet = walletClient();
  if (profile) {
    if (String(profile.owner).toLowerCase() !== wallet.account.address.toLowerCase()) {
      throw new InvalidFilterError("profile is claimed — edit it from your wallet");
    }
    const { txHash } = await wallet.patchEntity({
      entityKey: profile.key,
      set: { handle: str(name) },
    });
    return { action: "patched", entityKey: profile.key, txHash, handle: name };
  }
  const params = {
    payload: jsonToPayload({ handle: name, by: "eqora" }),
    contentType: "application/json",
    attributes: profileAttributes({ user, handle: name }),
    expires: EXPIRY.user_profile,
  };
  if (!claim) {
    const { entityKey, txHash } = await wallet.createEntity(params);
    return { action: "created", entityKey, txHash, handle: name, claimed: false };
  }
  const [predicted] = await withTimeout(
    publicClient.predictEntityKeys({ owner: wallet.account.address, count: 1 })
  );
  params.salt = predicted.salt;
  const selfOwned = String(user).toLowerCase() === wallet.account.address.toLowerCase();
  const ownershipChanges = selfOwned
    ? []
    : [{ entityKey: predicted.key, newOwner: user }];
  const result = await wallet.executeBatch({ creates: [params], ownershipChanges });
  const minted = String((result.createdEntities ?? [])[0] ?? predicted.key);
  return {
    action: "created",
    entityKey: minted,
    txHash: result.txHash,
    handle: name,
    claimed: minted === String(predicted.key),
    alreadyOwner: selfOwned,
  };
}

async function collectAttributePages(expression, { limit = 200 } = {}) {
  // Walk every page of a query — the async-iterator form the SDK exposes.
  const rows = [];
  let builder = publicClient.select({ attributes: true }).where(expression).limit(limit);
  for await (const entity of builder) rows.push(entity.attributes ?? {});
  return rows;
}

let leaderboardCache = { at: 0, rows: null };
const LEADERBOARD_TTL_MS = 30_000;

export async function getLeaderboard({ limit = 10, refresh = false } = {}) {
  const wallet = walletClient();
  const now = Date.now();
  if (refresh || !leaderboardCache.rows || now - leaderboardCache.at > LEADERBOARD_TTL_MS) {
    const rows = await readLeaderboardRows({ limit });
    leaderboardCache = { at: now, rows };
  }
  return { ...leaderboardCache, generatedAt: leaderboardCache.at, service: wallet.account.address };
}

async function readLeaderboardRows({ limit }) {
  // Aggregate the raw journal: total via async iteration, wins via gt().
  const totals = new Map();
  const journalRows = await collectAttributePages(eq("kind", str(ENTITY.trade_journal)));
  for (const attrs of journalRows) {
    const user = String(attrs.user?.value ?? "").toLowerCase();
    if (!user) continue;
    const row = totals.get(user) ?? { user: attrs.user.value, scoreBps: 0, trades: 0, wins: 0 };
    row.scoreBps += Number(attrs.pnl_bps?.value ?? 0);
    row.trades += 1;
    totals.set(user, row);
  }
  const winRows = await collectAttributePages(
    and(eq("kind", str(ENTITY.trade_journal)), gt("pnl_bps", i32(0)))
  );
  for (const attrs of winRows) {
    const user = String(attrs.user?.value ?? "").toLowerCase();
    const row = totals.get(user);
    if (row) row.wins += 1;
  }
  const ranked = [...totals.values()]
    .sort((a, b) => b.scoreBps - a.scoreBps)
    .slice(0, Math.max(1, Number(limit) || 10))
    .map((row, index) => ({ ...row, rank: index + 1 }));

  // Upsert leaderboard_entry entities on-chain (create new, patch + extend old).
  const existing = await listLeaderboardEntries();
  const byUser = new Map(existing.map((e) => [String(e.attributes.user).toLowerCase(), e]));
  const creates = [];
  const patches = [];
  const extensions = [];
  const createRows = [];
  for (const row of ranked) {
    const found = byUser.get(row.user.toLowerCase());
    if (found) {
      patches.push({ entityKey: found.key, set: leaderboardAttributes(row) });
      extensions.push({ entityKey: found.key, expires: EXPIRY.leaderboard_entry });
    } else {
      creates.push({
        payload: jsonToPayload({ recordedBy: "eqora-backend" }),
        contentType: "application/json",
        attributes: leaderboardAttributes(row),
        expires: EXPIRY.leaderboard_entry,
      });
      createRows.push(row);
    }
  }
  if (!creates.length && !patches.length) return ranked;

  const result = await walletClient().executeBatch({ creates, patches, extensions });
  const txHash = String(result.txHash);
  const createdKeys = (result.createdEntities ?? []).map((k) => String(k));
  return ranked.map((row) => ({
    ...row,
    entityKey: findRowKey(row, byUser, createdKeys, createRows),
    txHash,
  }));
}

function findRowKey(row, byUser, createdKeys, createRows) {
  const existingKey = byUser.get(row.user.toLowerCase())?.key;
  if (existingKey) return String(existingKey);
  const index = createRows.findIndex((r) => r.user === row.user);
  return index >= 0 ? String(createdKeys[index] ?? "") : null;
}

async function listLeaderboardEntries() {
  const page = await withTimeout(
    publicClient
      .select({ key: true, attributes: true, expiresAt: true })
      .where(eq("kind", str(ENTITY.leaderboard_entry)))
      .limit(200)
      .fetch()
  );
  return page.entities.map(serializeEntity);
}

export async function getArkivStatus() {
  const serviceWallet = config.privateKey ? privateKeyToAccount(config.privateKey).address : null;
  const [chainId, timing, entityCount, serviceNonce, glmWei] = await Promise.all([
    withTimeout(publicClient.getChainId()),
    withTimeout(publicClient.getBlockTiming()),
    withTimeout(publicClient.getEntityCount()),
    serviceWallet
      ? withTimeout(publicClient.getEntityNonce(serviceWallet))
      : Promise.resolve(0n),
    serviceWallet
      ? withTimeout(publicClient.getBalance({ address: serviceWallet }))
      : Promise.resolve(0n),
  ]);
  return {
    chainId,
    chainName: tiramisu.name,
    rpc: TIRAMISU_RPC,
    explorer: EXPLORER_URL,
    currentBlock: Number(timing.currentBlock),
    currentBlockTime: Number(timing.currentBlockTime),
    blockDuration: Number(timing.blockDuration),
    entityCount: Number(entityCount),
    serviceNonce: Number(serviceNonce),
    serviceWallet,
    glmBalance: (Number(glmWei) / 1e18).toFixed(4),
    accessKey: Boolean(config.tiramisuAccessKey),
    transport: transportState.via,
    sdk: `@arkiv-network/sdk ${SDK_VERSION}`,
  };
}

export function watchJournalEvents({ onEntity, onError } = {}) {
  const wsClient = createPublicClient({ chain: tiramisu, transport: wsTransport() });
  const KINDS = new Set(Object.values(ENTITY));
  const handle = (type) => async (event) => {
    if (!onEntity) return;
    try {
      const entity = await publicClient.getEntity(event.entityKey);
      const attributes = {};
      for (const [name, value] of Object.entries(entity.attributes ?? {})) {
        attributes[name] = value.value;
      }
      if (!KINDS.has(attributes.kind)) return;
      onEntity({
        type,
        entityKey: event.entityKey,
        txHash: event.transactionHash,
        blockNumber: Number(event.blockNumber),
        expiresAt: Number(entity.expiresAt),
        attributes,
        previousOwner: event.previousOwner,
        newOwner: event.newOwner,
        at: Date.now(),
      });
    } catch {
      return;
    }
  };
  return wsClient.watchEntityEvents({
    onEntityCreated: handle("created"),
    onEntityPatched: handle("patched"),
    onEntityDeleted: handle("deleted"),
    onExpiryExtended: handle("extended"),
    onOwnershipTransferred: handle("ownership"),
    onError: onError ?? ((error) => console.error("[arkiv watch]", error.message)),
  });
}
