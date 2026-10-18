# EQORA — Arkiv friction log

Every snag hit while building EQORA against Arkiv SDK 0.8.x + the Tiramisu
testnet node (chain 7738577). Exact errors quoted verbatim from the node/SDK,
with the workaround shipped in the code. This is honest build log, not a
complaint list — each gap had a clean workaround.

## 1. Three query operators are rejected by the Tiramisu node

The SDK accepts `ne(!=)`, `EXISTS()` and `TYPEOF()/hasType` client-side and
encodes them fine — the **node** refuses them at execution time:

```
Query rejected (type, -32002): Requested resource not available.. Query: side != str('buy')
Query rejected (type, -32002): Requested resource not available.. Query: EXISTS(leverage)
Query rejected (type, -32002): Requested resource not available.. Query: TYPEOF(size_wei) = u256
```

**Workaround** (`listTradeJournals` in `backend/src/arkiv.js`): send the exact
operator first; on `kind==="type" && code==="-32002"` retry once with a
semantically equivalent predicate on a fresh query builder:

| requested | fallback | reported to the UI as |
|---|---|---|
| `ne("side", str("buy"))` | `NOT side = str("buy")` | `ne→not(eq)` |
| `exists("leverage")` | `leverage > i32(0)` | `exists→gt(0)` |
| `TYPEOF(size_wei) = u256` | `size_wei > u256(0)` | `hasType→gt(zero)` |

Every list response carries `nodeFallbacks` and the `render()` string
(`page.query`), and the Journal UI shows both — so the gap is *visible*, not
hidden. Proven live by smoke step "raw ne/exists/hasType against node".

## 2. There is no "match every entity" query

```
A query needs at least one filter — the language has no spelling for 'match every entity'.
Add a where(...) predicate, or narrow by ownedBy(...) / createdBy(...)
```

**Workaround:** every query starts with `eq("kind", str("<collection>"))` —
the `kind` attribute doubles as the collection selector (also our substitute
for the missing type-of-entity filter).

## 3. `ownedBy()` wants raw hex — wrapping with `addr()` double-encodes

```
Invalid addr value {"type":"addr","value":"0xD25F8736C3Efc19a7cb7A3D15f2aF22c2980E317"}:
not a 20-byte 0x-prefixed hex address.
```

**Workaround:** `ownedBy("0xd25f…")` takes the hex string directly (case-insensitive);
`addr()` stays correct for *attribute* predicates (`eq("user", addr(...))`).

## 4. Attribute names must be lowercase — uppercase reverts opaquely

Writing `{ Kind: str("x") }` does not fail fast in the SDK; it reaches the node
and dies with no diagnostic:

```
Transaction failed: Execution error without revert data
```

**Workaround:** all attribute names are `snake_case` (`trade_type`, `size_wei`,
`created_ms`, …) and typed constants in `backend/src/arkiv.js`.

## 5. `payload` requires a lowercase RFC 2045 `contentType`

```
Invalid content type "undefined". Must follow RFC 2045 MIME grammar and be
lowercase only (e.g. "text/plain").
```

**Workaround:** every `createEntity`/`patchEntity` with a payload passes
`contentType: "text/plain"` (notes) explicitly.

## 6. `select()` is a builder — and `where()` accumulates

- `client.select()` must be called with `"*"` or a field-selection object, or
  you get: `select() requires at least one field to be selected. Pass select()
  or select("*") to select everything.`
- `.where()` **accumulates predicates across calls on the same builder**.
  Retrying a failed query on the same builder silently ANDs the old predicate
  into the new one.

**Workaround:** build a fresh `select("*").where(expr).limit(n)` builder per
attempt (the ne/exists/hasType retry does exactly this), and walk pages with
the async-iterator form (`for await (const e of builder)`), which the CSV
export uses.

## 7. `salt` is a uint128, not a 32-byte word

```
Invalid salt 0x1111…11. A salt is a uint128, so it must be between 0 and
340282366920938463463374607431768211455. Omit it to get 128 random bits, or
pass NO_SALT for a key derived from…
```

**Workaround:** `predictEntityKeys({owner, count})` + a random 16-byte (128-bit)
salt when the claim must happen in the same atomic batch as the create; omit
salt otherwise.

## 8. `u64`/`u256` attributes decode to `BigInt`

`JSON.stringify({ created_ms: 1792223516000n })` throws `Do not know how to
serialize a BigInt` — and `pnl_bps`/timestamps silently lose precision if cast
through `Number`.

**Workaround:** `serializeEntity` in `backend/src/arkiv.js` walks attributes
with a BigInt-aware replacer (BigInt → decimal string) and converts payload
with `toText()`. Timestamps are stored as `u64(Date.now())`, never `i32`
(ms-since-epoch overflows 32 bits immediately).

## 9. Rate limits / stalled reads without an access key

Pre-key, identical queries intermittently hung until the client-side guard
fired (`Arkiv read timed out` after 12s) and throughput collapsed.

**Workaround:**
- `TIRAMISU_ACCESS_KEY` in `backend/.env`, sent **path-style**
  (`https://rpc.tiramisu…/arkiv/<key>`; header `X-API-KEY` and `Authorization:
  Bearer` also work).
- Every read wrapped in `withTimeout()` (12s) so a stalled socket can't wedge
  the API.
- The key **never reaches the browser**: frontend reads go straight to the
  public RPC without credentials; all signing happens in MetaMask.

## 10. Browser-signed writes need GLM + a chain entry

MetaMask won't send Tiramisu transactions until the user adds the chain, and
every write costs GLM (the native gas token).

**Workaround** (`frontend/src/arkivWallet.js`):
- `wallet_switchEthereumChain`, falling back to `wallet_addEthereumChain`
  with the full Tiramisu descriptor.
- Pre-flight GLM balance check → clear error pointing to the Hub faucet
  (`hub.arkiv.network`) instead of an opaque revert.
- Backend service-wallet fallback (`POST /api/notes`, `PATCH /api/profile`) so
  the flow still works keyless-less/demo-only, always returning the tx/entity
  for the explorer link.

## 11. Claiming your own entity is a no-op the engine rejects

The demo service wallet *is* the demo user wallet
(`0xd25F…E317`), so `ownershipChanges` to the same address comes back as
"already owned by that account" and would fail the whole batch.

**Workaround:** `claimEntities`/`createNote`/`saveProfile` skip
`ownershipChanges` when `newOwner === signer` and respond
`{ txHash: null, alreadyOwned: n }`; the UI still shows "owned ✓" so the
ownership model is visible. Cross-wallet claims run the real
`changeOwnership` batch.

## 12. SDK package exports are a small fixed set

`@arkiv-network/sdk` only exports `.`, `./attr`, `./entity`, `./chains`,
`./query`, `./types`, `./utils` — importing anything else (e.g.
`./payload`) throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. `ExpirationTime` lives on
the root entry; predicates on `/query`; attribute constructors on `/attr`.

**Workaround:** import map mirrored in both `backend/src/arkiv.js` and
`frontend/src/arkiv.js` (the frontend uses the identical subpaths, which the
Vite build verifies).

## 13. `watchEntityEvents` sees only what happens after you subscribe

The stream is live — no backfill of past events — and the Tiramisu WS endpoint
is separate from the HTTP RPC.

**Workaround:** SSE bridge (`GET /api/events`) starts the watcher lazily on
first subscriber, pings every 25s, announces watched kinds in the `hello`
event, and the initial page load always comes from a normal paginated query,
never from the stream.

## 14. The access key has a monthly cost-unit quota — when it dies, the whole app dies

Keys raise rate limits but carry a **monthly quota measured in cost units**
(`hub.arkiv.network` → Usage shows burn + reset date). Heavy scan queries
(full-table aggregation for the leaderboard, batch verification runs) can burn
it in one session. The node then answers **every** keyed call with:

```
HTTP 429  {"error":"QUOTA_EXCEEDED","message":"quota exhausted"}
```

viem's built-in transport retry (3×, honors `Retry-After`) cannot outlast the
window — quota exhaustion is not a burst. Worse, `HttpRequestError` embeds the
full request URL, which contains the key path-style, so a raw
`error.message` sent to the browser would **leak the key**.

**Workaround (shipped):**
- Quota-aware transport in `backend/src/arkiv.js`: a custom viem transport
  tries the keyed URL first; on 429/`QUOTA_EXCEEDED` it flips sticky to the
  **keyless public RPC** (default rate limit, no quota) and keeps serving.
  State is exposed as `transport: key | fallback | public` on
  `/api/arkiv/status` and on the Proof card, so the degrade is visible, not
  silent.
- `errMsg()` in `backend/src/server.js` redacts `ark_live_…(redacted)` in
  every HTTP error body (23 response sites) — credentials never leave the
  backend.
- Read timeout raised 12s → 25s (env `ARKIV_READ_TIMEOUT_MS`): the public
  RPC's `Retry-After` backoff regularly exceeded the old guard.
- **Recovery is a Hub action:** *Request more quota* (Usage tab) or
  regenerate the key, then update `backend/.env` and restart. The old key
  stops working the moment you regenerate. Note: regenerating the key on the
  **same wallet** did not restore service (the cost counter kept the wallet's
  exhausted state after a lag); a key from a **fresh account** worked
  immediately.

*Reproduce everything: `cd backend && node src/arkiv-smoke.js` — write, query,
claim, ownership-transfer, watch, `lend_event` and raw `-32002` operator
probes, self-cleaning (every entity it creates is deleted at the end).*

## 15. Ownership gates everything — and "upsert by user" helpers will eat your demo data

Two lessons from the same bug family, both found the hard way (one destroyed
`loan_memo` + nine undeletable Explorer rows):

**Only the current owner can delete or re-transfer an entity — no creator
backdoor.** Hand a record to another account (even as a smoke "foreign
ownership" test) and your service wallet can never remove it:
`Transaction failed: entity 0x… is owned by 0x…, not 0x…`. The row stays in
every query until it expires. Our smoke test handed a note to a hardcoded
address each run and its cleanup silently skipped foreign-owned keys — nine
orphans piled up, each pinned to a third-party address forever.

**Workaround (shipped):** smoke generates a throwaway key per run, **dust-funds
it with 0.01 GLM** (a fresh account cannot even pay gas to hand the entity
back — the unsigned hand-back dies with a bare `Execution error without revert
data`), hands the note out for the `ownedBy()` check, signs the hand-back with
the throwaway key, and only then cleanup deletes it. `transferEntity` grew an
optional `signerKey` so a non-service owner can sign its own transfer.

**`syncLoanMemo` and `saveProfile` upsert by user (+ collateral symbol).** Any
test that calls them with the *demo* user's real identity silently adopts the
row that user already has — patches it, closes it, and then deletes it at
cleanup. One smoke run did exactly that to a live `loan_memo`. Smoke now uses
a `IND-SMOKE` collateral symbol and a dedicated smoke-only profile user, so
the demo wallet's rows are never matched.
