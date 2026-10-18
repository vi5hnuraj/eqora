# Arkiv Integration Reproduction & Verification Guide

This guide describes how to reproduce, test, and verify the live **Arkiv Tiramisu** integration in EQORA.

## 1. Network & Configuration

| Parameter | Value |
|---|---|
| **Network** | Arkiv Tiramisu Testnet |
| **Chain ID** | `7738577` (`0x7614d1`) |
| **HTTP RPC** | `https://rpc.tiramisu.db-chain.testnet.arkiv.network` |
| **WebSocket RPC** | `wss://rpc.tiramisu.db-chain.testnet.arkiv.network` |
| **Explorer** | `https://tiramisu.explorer.arkiv.network` |
| **SDK** | `@arkiv-network/sdk` 0.8.1 |
| **Faucet / Hub** | `https://hub.arkiv.network` |

---

## 2. Automated Smoke Test (39 Steps)

EQORA provides an automated smoke test suite that executes 39 operations directly on the live Arkiv Tiramisu testnet.

### How to Run:

```bash
# From repository root:
npm run arkiv:smoke

# Or from backend directory:
cd backend
npm run arkiv:smoke
```

### What the Smoke Test Verifies:

1. **Chain Status & Node Metadata**:
   - `getChainId`: Validates chain ID `7738577`.
   - `getBlockTiming`: Checks 2-second block duration.
   - `getEntityCount`: Queries total entity count on Tiramisu.
   - `getEntityNonce`: Reads the service wallet's creation nonce.
   - Verifies GLM balance and access-key transport.

2. **`trade_journal` Lifecycle**:
   - Creates a trade record with exact attribute types: `str`, `addr`, `dec`, `i32` (P&L in bps), `u64` (millisecond timestamp), and `u256` (`size_wei`).
   - Sets creation flags `{ readonly: true, permissionlessExtension: true }` (raw flags `3`).
   - Probes queries: `eq`, `range (gte/lte)`, `gt`, `or` (multi-symbol query), and `startsWith` (session prefix).
   - Tests fallback mechanisms for node gaps (`ne` -> `not(eq)`, `exists` -> `gt(0)`, `hasType` -> `gt(zero)`).

3. **`loan_memo` Lifecycle**:
   - `syncLoanMemo`: Creates or updates a collateral loan position memo.
   - `patchLoanMemo`: Modifies status directly via `patchEntity`.
   - Risk queries: Filters loans with health factor below threshold (`lt`).

4. **Atomic Batch Close (`executeBatch` & `predictEntityKeys`)**:
   - Atomically executes `createEntity`, `patchEntity`, and `extendEntity` in a single transaction.
   - Uses `predictEntityKeys` so that a newly created session snapshot accurately references a trade journal created in the same transaction.

5. **`lend_event` Mirroring**:
   - Mirrors on-chain Polygon Amoy lending actions (`supply`, `borrow`, `repay`, `withdraw`) to Arkiv.
   - Queries historical events filtered by user address and operation type.

6. **`journal_note` & Signed Ownership Claims**:
   - Creates a user annotation with `predictEntityKeys` and claims ownership.
   - Patches the note content and verifies SHA-256/keccak content hash update.
   - Executes `transferEntity` (`changeOwnership`) to a foreign address, verifies `ownedBy`, and hands it back.

7. **`user_profile` & `leaderboard_entry`**:
   - Stores and patches trader handle, bio, and Twitter handle.
   - Aggregates closed trade journals asynchronously and writes ranked leaderboard snapshots.

8. **Live Event Subscription (WebSocket -> SSE)**:
   - Subscribes to live WebSocket entity events (`watchJournalEvents`).
   - Verifies reception of `created`, `patched`, `deleted`, `extended`, and `ownership` events in real time.

9. **Deterministic Cleanup**:
   - Automatically deletes created test entities so test runs never pollute the production journal.

---

## 3. Manual Verification in the Frontend

1. Start backend and frontend:
   ```bash
   # Terminal 1:
   cd backend && npm run dev
   # Terminal 2:
   cd frontend && npm run dev
   ```
2. Open `http://localhost:5173` in a browser with MetaMask installed.
3. Navigate to **Activity** (`/activity`):
   - Check the **Live Arkiv Feed** for incoming entity events.
   - Switch tabs to view **Journal**, **Loan Memos**, **Notes**, **Profiles**, and **Leaderboard**.
4. Navigate to **Explorer** (`/explorer`):
   - Browse entities by collection (`trade_journal`, `loan_memo`, `journal_note`, `user_profile`, `leaderboard_entry`, `session_snapshot`, `lend_event`).
   - Click any entity key to open the record on the official [Arkiv Tiramisu Explorer](https://tiramisu.explorer.arkiv.network).
5. Execute a Trade:
   - On `/trade`, buy synthetic shares (e.g. `IND-RELIANCE`).
   - Close or sell the trade; notice the trade automatically written to Arkiv with an explorer link provided in the confirmation toast.
