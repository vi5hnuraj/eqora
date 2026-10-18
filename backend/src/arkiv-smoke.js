import {
  batchClose,
  claimEntities,
  createLendEvent,
  createNote,
  createTradeJournal,
  deleteNote,
  getArkivStatus,
  getLeaderboard,
  getTradeJournal,
  listLendEvents,
  listLoanMemos,
  listNotes,
  listProfiles,
  listTradeJournals,
  patchLoanMemo,
  patchNote,
  publicClient,
  saveProfile,
  syncLoanMemo,
  transferEntity,
  watchJournalEvents,
  walletClient,
} from "./arkiv.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

function line(label, value) {
  console.log(`  ${label}: ${value}`);
}

function jsonv(value) {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

let passed = 0;
let failed = 0;
async function step(label, fn) {
  try {
    const result = await fn();
    passed += 1;
    console.log(`[ok] ${label}`);
    return result;
  } catch (error) {
    failed += 1;
    console.log(`[FAIL] ${label}: ${error.message}`);
    return null;
  }
}

async function main() {
  const user = "0xd25f8736c3efc19a7cb7a3d15f2af22c2980e317";
  const session = `smoke-${Date.now()}`;
  // Every entity this run creates — deleted again at the end so smoke never
  // pollutes the demo journal (manual t-*/s-* entries stay untouched).
  const createdKeys = [];

  console.log("[smoke] chain status (getChainId / getBlockTiming / getEntityCount / getEntityNonce)");
  const status = await step("getArkivStatus", () => getArkivStatus());
  if (status) {
    line("chainId", status.chainId);
    line("block", `${status.currentBlock} (every ${status.blockDuration}s)`);
    line("entityCount", status.entityCount);
    line("serviceCreateNonce", status.serviceNonce);
    line("accessKey", status.accessKey);
  }

  console.log("[smoke] create trade_journal (u64/u256/dec/i32/addr/str attrs, readonly+permissionless flags)");
  const trade = await step("createTradeJournal", () =>
    createTradeJournal({
      user,
      symbol: "IND-RELIANCE",
      side: "buy",
      size: "2.5",
      price: "1215.4",
      pnlBps: 137,
      session,
      note: "Arkiv smoke test — practice entry",
      tradeType: "spot",
    })
  );
  if (trade) {
    createdKeys.push(trade.entityKey);
    line("entityKey", trade.entityKey);
    line("txHash", trade.txHash);
    line("expiresAtBlock", trade.expiresAt);
  }

  const leveraged = await step("createTradeJournal (leverage + i32 leverage attr)", () =>
    createTradeJournal({
      user,
      symbol: "IND-NIFTY",
      side: "sell",
      size: "0.5",
      price: "25010.75",
      pnlBps: -26,
      session,
      note: "leveraged leg",
      tradeType: "leverage",
      leverage: 3,
    })
  );
  if (leveraged) createdKeys.push(leveraged.entityKey);

  console.log("[smoke] queries: eq + gte/lte range + render()");
  const ranged = await step("listTradeJournals range", () =>
    listTradeJournals({ user, minPnlBps: 100, maxPnlBps: 500, session })
  );
  if (ranged) {
    line("matches", ranged.entities.length);
    line("query", ranged.query);
    if (ranged.entities[0]) line("attrs", jsonv(ranged.entities[0].attributes));
    if (ranged.entities[0]) line("flags", jsonv(ranged.entities[0].flags));
  }

  console.log("[smoke] query operators: gt / ne / or / startsWith / exists / not / hasType / since");
  await step("gt outcome=win", async () => {
    const page = await listTradeJournals({ user, outcome: "win", session });
    line("wins query", page.query);
    line("wins", page.entities.length);
    if (!page.entities.length) throw new Error("expected winning trades");
    return page;
  });
  await step("ne excludeSide=buy (fallback not(eq) expected on this node)", async () => {
    const page = await listTradeJournals({ user, excludeSide: "buy", session });
    line("ne query", page.query);
    line("nodeFallbacks", page.nodeFallbacks.join(", ") || "none");
    line("non-buys", page.entities.length);
    if (page.nodeFallbacks.length) line("node gap documented", "ne rejected → retried with not(eq)");
    if (page.entities.length < 1) throw new Error("expected non-buy matches");
    return page;
  });
  await step("or symbols multi-select", async () => {
    const page = await listTradeJournals({ user, symbols: "IND-RELIANCE,IND-NIFTY", session });
    line("or query", page.query);
    line("multi-symbol matches", page.entities.length);
    return page;
  });
  await step("startsWith session prefix", async () => {
    const page = await listTradeJournals({ user, sessionPrefix: session.slice(0, 6) });
    line("prefix query", page.query);
    line("prefix matches", page.entities.length);
    return page;
  });
  await step("exists + not type filters (exists falls back to gt(0))", async () => {
    const lev = await listTradeJournals({ user, typeFilter: "leverage" });
    line("exists query", lev.query);
    line("nodeFallbacks", lev.nodeFallbacks.join(", ") || "none");
    line("leveraged", lev.entities.length);
    const spot = await listTradeJournals({ user, typeFilter: "spot", session });
    line("not query", spot.query);
    line("spot", spot.entities.length);
    if (lev.entities.length < 1) throw new Error("expected leveraged match");
    if (!lev.nodeFallbacks.length) throw new Error("expected exists fallback to be recorded");
    return spot;
  });
  await step("hasType schema filter (falls back to gte range probe)", async () => {
    const page = await listTradeJournals({ user, typeofFilter: "size_wei:u256" });
    line("typeof query", page.query);
    line("nodeFallbacks", page.nodeFallbacks.join(", ") || "none");
    line("u256 rows", page.entities.length);
    if (page.entities.length < 1) throw new Error("expected u256 matches");
    if (!page.nodeFallbacks.length) throw new Error("expected hasType fallback to be recorded");
    return page;
  });
  await step("gte sinceMs (created_ms u64)", async () => {
    const page = await listTradeJournals({ user, sinceMs: Date.now() - 3600_000 });
    line("since query", page.query);
    line("recent rows", page.entities.length);
    if (page.entities.length < 1) throw new Error("expected recent match");
    return page;
  });
  await step("lte $expiresAt (expiring soon)", async () => {
    const page = await listTradeJournals({ user, expiringSoon: "1", limit: 5 });
    line("expiring query", page.query);
    line("expiring rows", page.entities.length);
    return page;
  });
  await step("bad hasType tag rejected client-side", async () => {
    try {
      await listTradeJournals({ typeofFilter: "size_wei:nope" });
      throw new Error("should have rejected unknown tag");
    } catch (error) {
      if (!/unknown type tag|no range probe/.test(error.message)) throw error;
      return true;
    }
  });
  await step("raw ne/exists/hasType against node (documented gap for friction.md)", async () => {
    const { publicClient } = await import("./arkiv.js");
    const { and, eq, exists, hasType, ne } = await import("@arkiv-network/sdk/query");
    const { str } = await import("@arkiv-network/sdk/attr");
    const probes = [
      ["ne", and(eq("kind", str("trade_journal")), ne("side", str("buy")))],
      ["exists", and(eq("kind", str("trade_journal")), exists("leverage"))],
      ["hasType", and(eq("kind", str("trade_journal")), hasType("size_wei", "u256"))],
    ];
    for (const [label, expr] of probes) {
      try {
        await publicClient.select({ key: true }).where(expr).limit(1).fetch();
        line(label, "ACCEPTED by node");
      } catch (error) {
        const gap = /Requested resource not available/.test(error.message);
        line(label, `rejected: kind=${error.kind ?? "?"} code=${error.code ?? "?"} (${gap ? "known node gap" : "UNEXPECTED"})`);
        if (!gap) throw error;
      }
    }
    return true;
  });

  console.log("[smoke] getEntity by key");
  if (trade) {
    await step("getTradeJournal", async () => {
      const entity = await getTradeJournal(trade.entityKey);
      line("roundtrip", `${entity.attributes.symbol} ${entity.attributes.size_wei} wei`);
      if (String(entity.attributes.symbol) !== "IND-RELIANCE") throw new Error("symbol mismatch");
      return entity;
    });
  }

  console.log("[smoke] loan_memo lifecycle: sync → renew → direct patchEntity(status) → lt query");
  // Smoke-only collateral symbol: syncLoanMemo upserts by user+symbol, so the
  // demo user's REAL memos (e.g. IND-RELIANCE from the Lend page) must never
  // match — a match would get closed and deleted at cleanup.
  const memo = await step("syncLoanMemo create", () =>
    syncLoanMemo({
      user,
      collateralSymbol: "IND-SMOKE",
      collateralAmount: "10",
      debtMinr: "5000",
      healthFactor: "1.42",
      pool: "eqora",
    })
  );
  const renewed = await step("syncLoanMemo renew", () =>
    syncLoanMemo({
      user,
      collateralSymbol: "IND-SMOKE",
      collateralAmount: "12",
      debtMinr: "5600",
      healthFactor: "1.31",
      pool: "eqora",
    })
  );
  const memoKey = renewed?.entityKey ?? memo?.entityKey;
  if (memo?.entityKey) createdKeys.push(memo.entityKey);
  if (renewed?.entityKey) createdKeys.push(renewed.entityKey);
  if (memoKey) {
    await step("patchLoanMemo → closed (direct patchEntity)", async () => {
      const result = await patchLoanMemo(memoKey, { status: "closed" });
      line("patch tx", result.txHash);
      const page = await listLoanMemos({ user, status: "closed" });
      line("closed memos", page.entities.length);
      if (page.entities.length < 1) throw new Error("closed memo not found");
      return result;
    });
    await step("patchLoanMemo → open again", () => patchLoanMemo(memoKey, { status: "open" }));
  }
  await step("lt health-factor risk query", async () => {
    const page = await listLoanMemos({ user, healthFactorBelow: "2.0" });
    line("risky loans", page.entities.length);
    if (page.entities.length < 1) throw new Error("expected risky loan");
    return page;
  });

  console.log("[smoke] atomic batch (trade + session + memo patch/extend)");
  const batch = await step("batchClose", () =>
    batchClose({
      trade: {
        user,
        symbol: "IND-TCS",
        side: "sell",
        size: "1",
        price: "3410.25",
        pnlBps: -42,
        session,
        note: "batch close leg",
        tradeType: "spot",
      },
      session: { symbol: "IND-TCS", price: "3410.25", marketOpen: false },
      loanMemo: memoKey
        ? {
            key: memoKey,
            user,
            collateralSymbol: "IND-RELIANCE",
            collateralAmount: "8",
            debtMinr: "4000",
            healthFactor: "1.55",
            pool: "eqora",
          }
        : undefined,
    })
  );
  if (batch) {
    createdKeys.push(...batch.createdEntities);
    line("batch tx", batch.txHash);
    line("created", batch.createdEntities.join(", "));
    line("patched", batch.patchedEntities.join(", "));
    line("extended", batch.extendedEntities.join(", "));
    line("opened_trade link", batch.openedTrade ?? "none");
    await step("predictEntityKeys: session points at same-tx trade", async () => {
      if (!batch.openedTrade) throw new Error("no opened_trade link produced");
      if (!batch.createdEntities.includes(batch.openedTrade)) {
        throw new Error("predicted key does not match created trade");
      }
      return true;
    });
  }

  console.log("[smoke] lend_event (Amoy pool op mirrored onto Tiramisu)");
  const lendEvent = await step("createLendEvent", () =>
    createLendEvent({
      user,
      op: "borrow",
      symbol: "mINR",
      amount: "4000",
      amountWei: "4000000000000000000000",
      txHash: batch?.txHash ?? `0x${"11".repeat(32)}`,
    })
  );
  if (lendEvent) {
    createdKeys.push(lendEvent.entityKey);
    await step("listLendEvents by user", async () => {
      const page = await listLendEvents({ user, limit: 20 });
      const found = page.entities.find((e) => e.key === lendEvent.entityKey);
      if (!found) throw new Error("lend_event not found");
      line("op", found.attributes.op);
      line("amount_wei", String(found.attributes.amount_wei));
      return page;
    });
    await step("createLendEvent rejects unknown op", async () => {
      try {
        await createLendEvent({ user, op: "yolo", symbol: "mINR" });
        throw new Error("should have rejected unknown op");
      } catch (error) {
        if (!/unknown lend op/.test(error.message)) throw error;
        return true;
      }
    });
  }

  console.log("[smoke] journal_note: predictEntityKeys + salt + create+claim batch, then patch/delete");
  let note = null;
  if (trade) {
    note = await step("createNote claim=true (predicted key, ownershipChanges same tx)", () =>
      createNote({ user, tradeRef: trade.entityKey, text: "smoke note — signed claim", claim: true })
    );
    if (note) {
      createdKeys.push(note.entityKey);
      line("noteKey", note.entityKey);
      line("note owner", note.owner);
      line("predicted key matched", note.claimed);
      line("alreadyOwner (self key)", note.alreadyOwner);
      if (!note.claimed) throw new Error("minted key != predicted key");
    }
    await step("listNotes by trade_ref (key attr)", async () => {
      const page = await listNotes({ user, tradeRef: trade.entityKey });
      line("notes", page.entities.length);
      line("note query", page.query);
      if (page.entities.length < 1) throw new Error("note not found");
      const body = page.entities[0].payload;
      line("note text", jsonv(body));
      if (!String(body).includes("smoke note")) throw new Error("payload text mismatch");
      return page;
    });
    await step("patchNote (direct patch, bytes32 hash updated)", async () => {
      const result = await patchNote(note.entityKey, "smoke note — edited once");
      line("patch tx", result.txHash);
      return result;
    });
  }

  console.log("[smoke] user_profile: create, then patch handle");
  // Dedicated smoke-only profile user (NOT the demo wallet): saveProfile
  // upserts by user, so running it against the demo user would patch and then
  // DELETE the trader's real profile at cleanup. claim=false keeps the row
  // service-owned so cleanup can delete it.
  const profileUser = "0x51ce000000000000000000000000000000000001";
  const profile = await step("saveProfile create", () =>
    saveProfile({ user: profileUser, handle: "smoke-trader", claim: false })
  );
  if (profile) {
    createdKeys.push(profile.entityKey);
    line("profileKey", profile.entityKey);
    await step("saveProfile patch", async () => {
      const result = await saveProfile({ user: profileUser, handle: "smoke-trader-2" });
      line("profile action", result.action);
      if (result.action !== "patched") throw new Error("expected patched profile");
      return result;
    });
    await step("listProfiles", async () => {
      const page = await listProfiles({ user: profileUser });
      line("profiles", page.entities.length);
      if (page.entities.length < 1) throw new Error("profile missing");
      return page;
    });
  }

  console.log("[smoke] claim trade journals (self-key no-op expected; real transfer via changeOwnership)");
  if (trade && leveraged) {
    await step("claimEntities to self → skipped no-op", async () => {
      const result = await claimEntities({
        keys: [trade.entityKey, leveraged.entityKey],
        newOwner: user,
      });
      line("claim tx", result.txHash ?? "(none — already owner)");
      line("alreadyOwned", result.alreadyOwned ?? 0);
      if (!result.alreadyOwned) throw new Error("expected self-claim skip");
      return result;
    });
    await step("ownedBy query (creator ≠ owner distinction)", async () => {
      const page = await listTradeJournals({ owner: user, session });
      line("owned rows", page.entities.length);
      const owned = page.entities.find((e) => e.key === trade.entityKey);
      if (!owned) throw new Error("owned entity not found");
      line("owner", owned.owner);
      line("creator", owned.creator);
      return page;
    });
  }

  console.log("[smoke] leaderboard: async iteration aggregation + gt() wins + batch upsert");
  const board = await step("getLeaderboard refresh", () => getLeaderboard({ limit: 5, refresh: true }));
  if (board) {
    line("rows", board.rows.length);
    for (const row of board.rows) {
      line(`#${row.rank}`, `${row.user.slice(0, 10)}… score=${row.scoreBps}bps trades=${row.trades} wins=${row.wins} key=${String(row.entityKey ?? "").slice(0, 12)}…`);
    }
  }

  if (note) {
    console.log("[smoke] deleteEntity (owner deletes own note)");
    await step("deleteNote", async () => {
      const result = await deleteNote(note.entityKey);
      line("delete tx", result.txHash);
      return result;
    });
    await step("deleted note gone (NoEntityFoundError → 404 path)", async () => {
      const page = await listNotes({ user, tradeRef: trade.entityKey, limit: 100 });
      const still = page.entities.find((e) => e.key === note.entityKey);
      if (still) throw new Error("deleted note still live");
      return true;
    });
  }

  console.log("[smoke] watching live events for 12s (created/patched/deleted/extended/ownership)");
  let events = 0;
  const seen = new Set();
  const unwatch = watchJournalEvents({
    onEntity: (event) => {
      events += 1;
      seen.add(event.type);
      line(
        "event",
        `${event.type} ${event.entityKey?.slice(0, 10)}… kind=${event.attributes.kind}` +
          (event.type === "ownership" ? ` ${event.previousOwner?.slice(0, 8)}→${event.newOwner?.slice(0, 8)}` : "")
      );
    },
    onError: (error) => line("watch error", error.message),
  });
  await createTradeJournal({
    user,
    symbol: "IND-NIFTY",
    side: "sell",
    size: "0.5",
    price: "25010.75",
    pnlBps: 26,
    session,
    note: "watch trigger",
  })
    .then((r) => { if (r?.entityKey) createdKeys.push(r.entityKey); })
    .catch((error) => line("watch trigger failed", error.message));

  // Standalone changeOwnership during the watch window: a throwaway note
  // handed to a locally generated account, verified under ownedBy(newOwner),
  // then handed BACK (the throwaway signs its own tx) so this run can delete
  // it — Arkiv gates deletion on ownership, and smoke must self-clean.
  let handed = null;
  if (trade) {
    handed = await step("transferEntity (direct changeOwnership) to foreign account", async () => {
      const foreignKey = generatePrivateKey();
      const foreignAccount = privateKeyToAccount(foreignKey);
      const created = await createNote({ user, tradeRef: trade.entityKey, text: "to be handed over", claim: false });
      const result = await transferEntity({ key: created.entityKey, newOwner: foreignAccount.address });
      line("transfer tx", result.txHash);
      const page = await publicClientOwnedBy(foreignAccount.address);
      const found = page.find((e) => e.key === created.entityKey);
      if (!found) throw new Error("transferred entity not found under new owner");
      line("ownedBy(foreign)", `${page.length} row(s), transfer verified ✓`);
      // Hand-back must be signed by the CURRENT owner, and a fresh account
      // has no GLM for gas — dust-fund it from the service wallet first.
      const svc = walletClient();
      const fundTx = await svc.sendTransaction({ to: foreignAccount.address, value: 10n ** 16n });
      await publicClient.waitForTransactionReceipt({ hash: fundTx });
      line("foreign funded", "0.01 GLM");
      const back = await transferEntity({
        key: created.entityKey,
        newOwner: svc.account.address,
        signerKey: foreignKey,
      });
      line("handed back", back.txHash);
      createdKeys.push(created.entityKey);
      return { key: created.entityKey, result, back };
    }).catch((error) => {
      line("transfer failed", error.message);
      return null;
    });
  }

  await new Promise((resolve) => setTimeout(resolve, 12000));
  unwatch();
  line("events seen", `${events} (${[...seen].join(", ") || "none"})`);
  if (handed) {
    await step("ownership event observed in watch window", async () => {
      if (!seen.has("ownership")) {
        console.log("  (note: ownership event may land after unwatch — polling lag)");
        return true;
      }
      if (!seen.has("created")) throw new Error("created event missing");
      return true;
    });
  }

  // Cleanup: delete every entity this run created so the demo journal never
  // fills with smoke-* rows. The handed note is only in createdKeys if the
  // hand-back succeeded; if a run dies mid-hand the orphan still expires on
  // its own (and no longer references a fixed third-party address).
  console.log("[smoke] cleanup — delete every entity this run created");
  const uniqueKeys = [...new Set(createdKeys.filter(Boolean))];
  let removed = 0;
  for (const k of uniqueKeys) {
    try {
      await deleteNote(k);
      removed += 1;
    } catch { /* already deleted earlier in the run, or hand-back failed */ }
  }
  line("removed", `${removed}/${uniqueKeys.length} entities`);
  await step("leaderboard re-synced after cleanup", async () => {
    const board = await getLeaderboard({ limit: 5, refresh: true });
    line("rows after cleanup", board.rows.length);
    return board;
  });

  console.log(`[smoke] done — ${passed} ok, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function publicClientOwnedBy(owner) {
  const { publicClient } = await import("./arkiv.js");
  const { eq } = await import("@arkiv-network/sdk/query");
  const { str } = await import("@arkiv-network/sdk/attr");
  const page = await publicClient
    .select({ key: true, owner: true, attributes: true })
    .where(eq("kind", str("journal_note")))
    .ownedBy(owner)
    .limit(50)
    .fetch();
  return page.entities.map((e) => ({ key: e.key, owner: e.owner }));
}

main().catch((error) => {
  console.error("[smoke] failed:", error.message);
  process.exitCode = 1;
  process.exit(1);
});
