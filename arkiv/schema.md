# EQORA — Arkiv schema

> Synced with the implementation in `backend/src/arkiv.js`, `backend/src/server.js`
> and the browser clients `frontend/src/arkiv.js` / `frontend/src/arkivWallet.js`.
> Network: **Tiramisu testnet** (chain ID 7738577, RPC
> `https://rpc.tiramisu.db-chain.testnet.arkiv.network`, explorer
> `https://tiramisu.explorer.arkiv.network`).

## Design rule

Arkiv stores only **synthetic demo data**. No real personal data, no keys, no
secrets, no real KYC. The on-chain lending state (collateral, debt, health
factor) lives in the smart contracts on Polygon Amoy — Arkiv holds the
**journal, lending events, notes, memos, snapshots, profile and leaderboard**
that make a trader's track record queryable and unfakeable.

Every entity carries a `kind` attribute (`str`) naming its collection. Arkiv
queries need at least one predicate and the Tiramisu node has no type-filter
support, so `kind` doubles as the collection selector.

Attribute names are **snake_case** (Arkiv rejects uppercase letters in names).
Numeric attributes: `dec` (decimal strings) for display money, `i32` for signed
P&L/bps, `u64` for exact timestamps, `u256` for wei-exact sizes, `bytes32` for
content hashes, `key()` for entity cross-references, `addr()` for addresses.

## Entity types (7)

### 1. `trade_journal` — one entity per closed trade

| Attribute | Type | Arkiv constructor | Notes |
|---|---|---|---|
| `kind` | string | `str("trade_journal")` | collection selector |
| `user` | address | `addr(0x…)` | the demo trader |
| `symbol` | string | `str` | `IND-RELIANCE` / `IND-TCS` / `IND-NIFTY` … |
| `side` | string | `str` | `buy` or `sell` |
| `size` | decimal | `dec` | display size in tokens |
| `price` | decimal | `dec` | execution price (₹) |
| `pnl_bps` | i32 | `i32` | realized P&L in bps (signed; range-queried) |
| `session` | string | `str` | groups trades of one practice session |
| `trade_type` | string | `str` | `spot` or `leverage` |
| `size_wei` | u256 | `u256` | **exact** decimal→wei conversion (schema-verified) |
| `leverage` | i32 | `i32` | present only when `trade_type = "leverage"` |
| `created_ms` | u64 | `u64(Date.now())` | exact close time (u64 survives >2^53 ms) |

- **Payload:** the free-text note attached at record time.
- **Expiration:** `ExpirationTime.fromDays(90)`.
- **Creation flags:** `{ readonly: true, permissionlessExtension: true }`
  (raw flags value `3`) — the record is immutable, yet anyone can extend its
  lease so a good track record never dies.
- **Queries the app runs:** `eq` (kind/user/symbol/session/side/trade_type),
  `gt/lt/gte/lte` (`pnl_bps`, `leverage`, `size_wei`, `created_ms`), `or`
  (multi-symbol), `not`, `startsWith` (session prefix), `$expiresAt <= u64(block+7d)`,
  `ownedBy(hex)`, `createdBy(addr)`, cursor pagination (latest first).
  Each response returns `render()` output (`page.query`) plus `nodeFallbacks`.

### 2. `journal_note` — user-signed annotations

| Attribute | Type | Arkiv constructor | Notes |
|---|---|---|---|
| `kind` | string | `str("journal_note")` | collection selector |
| `user` | address | `addr(0x…)` | note author |
| `trade_ref` | entity key | `key(0x…)` | cross-reference to the `trade_journal` |
| `text_hash` | bytes32 | `bytes32(keccak256(toHex(text)))` | integrity: payload ↔ hash |
| `created_ms` | u64 | `u64(Date.now())` | write time |

- **Payload:** `text/plain` note body (exact text — verified by recomputing
  keccak256 in the browser, `◆` in the UI).
- **Expiration:** `ExpirationTime.atDate(YEAR_END, { atLeast: fromDays(30) })`.
- **Writes:** browser-signed first (`signCreateNote` — predicted key + salt +
  one atomic `executeBatch` of create + `ownershipChanges` claim), service
  fallback via `POST /api/notes`.

### 3. `loan_memo` — open lending position lease

| Attribute | Type | Arkiv constructor | Notes |
|---|---|---|---|
| `kind` | string | `str("loan_memo")` | collection selector |
| `user` | address | `addr(0x…)` | position owner |
| `collateral_symbol` | string | `str` | pledged stock token |
| `collateral_amount` | decimal | `dec` | pledged amount |
| `debt_minr` | decimal | `dec` | borrowed mINR |
| `health_factor` | decimal | `dec` | risk metric at last sync |
| `status` | string | `str` | `open` / `closed` (patchable) |
| `created_ms` | u64 | `u64(Date.now())` | first write |

- **Expiration:** 7 days; renewed with `extendEntity` on every touch (lease
  pattern — closed positions let their memo expire).
- **Queries:** `user`, `status`, `lt(health_factor)` risk list, `$expiresAt` window.

### 4. `session_snapshot` — market snapshot at session start

| Attribute | Type | Arkiv constructor | Notes |
|---|---|---|---|
| `kind` | string | `str("session_snapshot")` | collection selector |
| `symbol` | string | `str` | instrument |
| `price` | decimal | `dec` | ₹ price at session start |
| `market_open` | bool | `bool(true)` | NSE window status |
| `opened_trade` | entity key | `key(0x…)` | **batch close:** same-tx link to the `trade_journal` written with it |
| `created_ms` | u64 | `u64(Date.now())` | write time |

- **Expiration:** 48 hours (deliberately short — demonstrates per-type expiry).

### 5. `user_profile` — trader handle

| Attribute | Type | Arkiv constructor | Notes |
|---|---|---|---|
| `kind` | string | `str("user_profile")` | collection selector |
| `user` | address | `addr(0x…)` | profile owner |
| `handle` | string | `str` | chosen handle |
| `created_ms` | u64 | `u64(Date.now())` | create time |

- **Expiration:** `ExpirationTime.permanent()` — a handle is forever.
- **Writes:** browser-signed create/patch with claim, service fallback
  `POST /api/profile`.

### 6. `leaderboard_entry` — aggregated score, written on-chain

| Attribute | Type | Arkiv constructor | Notes |
|---|---|---|---|
| `kind` | string | `str("leaderboard_entry")` | collection selector |
| `user` | address | `addr(0x…)` | ranked trader |
| `score_bps` | i32 | `i32` | cumulative P&L in bps |
| `wins` | i32 | `i32` | trades with `pnl_bps > 0` (browser-direct `gt()` query) |
| `trades` | u64 | `u64` | trade count |
| `rank` | i32 | `i32` | position after aggregation |
| `updated_ms` | u64 | `u64(Date.now())` | last sync |
| `created_ms` | u64 | `u64(Date.now())` | create time |

- **Expiration:** 30 days (re-synced keeps it alive).
- **Writes:** `GET /api/leaderboard?refresh=1` aggregates the journal
  (`pnl_bps` sum + `gt(pnl_bps,0)` wins) and upserts every entry in **one
  atomic batch** (creates + patches + `extensions`), 30s server cache.

### 7. `lend_event` — every pool operation, mirrored from Amoy

Supply, withdraw, borrow, repay and collateral-toggle execute as **Polygon
Amoy** transactions (money-math lives there — Tiramisu is not an EVM). After
each confirmed tx the Lend page writes the operation here, so the Arkiv
journal covers lending alongside trades.

| Attribute | Type | Arkiv constructor | Notes |
|---|---|---|---|
| `kind` | string | `str("lend_event")` | collection selector |
| `user` | address | `addr(0x…)` | wallet that executed the op |
| `op` | string | `str` | `supply` \| `withdraw` \| `borrow` \| `repay` \| `toggle` |
| `symbol` | string | `str` | collateral asset (`IND-*`) or `mINR` |
| `amount` | string | `str` | human units as entered |
| `amount_wei` | u256 | `u256` | wei-exact amount (0 for `toggle`) |
| `tx` | string | `str` | Amoy transaction hash that executed it |
| `collateral_on` | bool | `bool` | only on `toggle` — new enabled state |
| `created_ms` | u64 | `u64(Date.now())` | create time |

- **Expiration:** 90 days, flags `3` (readonly + permissionless extension) —
  same family as `trade_journal`.
- **Writes:** `POST /api/lend-events` after each Amoy tx (validated against
  the op whitelist; unknown ops rejected client-side before touching the node).
- **Queries:** `eq(kind)` + `eq(user)`; surfaced on Activity under Position
  memos and in the Explorer's record browser.

## Query capabilities & node fallbacks

Operators verified against the Tiramisu node: `=`, `<`, `<=`, `>`, `>=`,
`AND`, `OR`, `NOT`, `STARTSWITH`, `$owner`, `$creator`, `$expiresAt`, cursor
pagination, `ownedBy(hex)`, `createdBy(addr)`.

**Node gaps (see `arkiv/friction.md`):** `ne(!=)`, `EXISTS()`,
`TYPEOF()/hasType` return `Requested resource not available (type, -32002)`.
`listTradeJournals` sends the exact operator first and retries once with an
equivalent, reporting what it substituted:

| requested | fallback | reported as |
|---|---|---|
| `ne("side", str("buy"))` | `NOT side = str("buy")` | `ne→not(eq)` |
| `exists("leverage")` | `leverage > i32(0)` | `exists→gt(0)` |
| `TYPEOF(size_wei) = u256` | `size_wei > u256(0)` | `hasType→gt(zero)` |

Every list response carries `page.query` (the `render()` string the node
parsed) and `nodeFallbacks` — the UI shows both as an inspector panel.

## Ownership & claims

Entities are created by the service wallet but **owned by the user**:

- Create/claim path: `predictEntityKeys` → salt → atomic `executeBatch`
  (create + `ownershipChanges`), or standalone `changeOwnership` for
  `POST /api/journal/claim`.
- Self-transfer is skipped server-side (returns `alreadyOwned`) — the service
  wallet and demo user wallet are the same address.
- Browser writes always come from the user's own MetaMask (nonce from
  `getBlockTiming`, signed by `window.ethereum`).

## Batch writes

`POST /api/journal/batch` writes an exit trade + session rollup + loan
memo patch/extend in **one atomic `executeBatch`**, with the trade key
predicted first so the snapshot gets `opened_trade: key(...)` in the same
transaction. Either all land or none.

## Live updates

`GET /api/events` — SSE bridge over `watchJournalEvents` (SDK
`watchEntityEvents`): `created`, `ownership` (and mutation) events with entity
key + attributes pushed to the UI; `event: hello` announces
chain + watched kinds.

## API surface (backend)

| Route | Arkiv operation |
|---|---|
| `GET /api/journal?user=&symbols=&outcome=&side=&excludeSide=&typeFilter=&typeofFilter=&sessionPrefix=&minPnlBps=&maxPnlBps=&sinceMs=&owner=&creator=&expiringSoon=&limit=&cursor=` | compound attribute query + range + `startsWith` + `$expiresAt` + `ownedBy`/`createdBy`, cursor pagination, `render()` |
| `POST /api/journal` | `createEntity` (90d, flags `3`) |
| `POST /api/journal/claim` | `changeOwnership` (self-skip) |
| `POST /api/journal/batch` | `executeBatch` + `predictEntityKeys` cross-link |
| `GET /api/journal/:key` / `PATCH` / `DELETE` | `getEntity` / `patchEntity` / `deleteEntity` |
| `GET /api/loans?user=&healthFactorBelow=&status=` | `lt()` risk query |
| `POST /api/loans` / `PATCH /api/loans/:key` | create or patch + `extendEntity` (7d lease) |
| `GET /api/lend-events?user=&limit=` / `POST /api/lend-events` | `eq(kind)+eq(user)` query / `createEntity` (90d, flags `3`) — every Amoy pool op |
| `GET /api/sessions?symbol=` | snapshot query |
| `POST /api/sessions` | `createEntity` (48h) |
| `GET /api/notes?user=&tradeRef=` | note query (key attr) |
| `POST /api/notes` / `PATCH|DELETE /api/notes/:key` | create+claim / `patchEntity` (rehash) / `deleteEntity` |
| `GET /api/profile?user=` / `POST` / `PATCH /api/profile` | `user_profile` list / create+claim / patch |
| `GET /api/leaderboard?refresh=1&limit=` | aggregation + atomic upsert batch (30s cache) |
| `GET /api/arkiv/status` | `getChainId` + `getBlockTiming` + `getEntityCount` + `getEntityNonce` |
| `GET /api/events` | `watchEntityEvents` SSE stream |

## Browser-direct layer (frontend)

The browser talks to Tiramisu **without the backend** for reads and signs its
own writes:

- `frontend/src/arkiv.js` — status, entity fetch, notes, `ownedBy` trades,
  `gt()` win count, CSV export via the SDK async iterator (`for await`),
  keccak256 note-hash verification, explorer URLs (`/entity/<key>`,
  `/tx/<hash>`, `/address/<addr>`).
- `frontend/src/arkivWallet.js` — `wallet_addEthereumChain` for Tiramisu,
  GLM balance check with faucet pointer, browser-signed note/profile
  create/patch/delete, permissionless `extendEntity`, on-chain re-verify.

## Wallet addresses (disclosure)

| Address | Role |
|---|---|
| `0xd25f8736c3efc19a7cb7a3d15f2af22c2980e317` | service wallet: creates/owns Arkiv entities on Tiramisu (key in `backend/.env`, never shipped to the browser); deploys & funds contracts on Polygon Amoy |

## Deliberately NOT stored on Arkiv

- Live contract state (collateral/debt balances) — belongs on-chain in the
  pool (Tiramisu has no EVM). Every state-changing **operation** (supply,
  withdraw, borrow, repay, toggle) is mirrored as a `lend_event` so the
  history still lives in Arkiv.
- Any real personal data, API keys, private keys — disallowed by the rules; synthetic demo data only.
