# EQORA — Hackathon Submission & Provenance Disclosure

**Event**: Arkiv Global Tour Stop  
**Project Name**: EQORA  
**Tagline**: *Trade. Lend. Prove it on-chain.*  
**License**: MIT License  

---

## 1. Executive Summary

EQORA is a blockchain-based Indian-stock practice trading and collateral-lending application with an unfakeable on-chain activity journal powered by **Arkiv**.

In India, retail traders frequently face misleading performance screenshots, fabricated P&L statements, and unregulated "finfluencer" trading claims. EQORA solves this by writing every closed trade, open loan memo, and trader note directly to **Arkiv Tiramisu** as structured, queryable, and immutable records. Traders can build an unfakeable track record without risking real money on live brokerages.

---

## 2. Hackathon Track & Work Scope

- **Tracks**:
  - **Primary**: Best Indian Use Case
  - **Secondary**: Open Source
- **Architecture Highlights**:
  - Full domain migration to Indian equities: integration of National Stock Exchange (NSE) symbols (`IND-RELIANCE`, `IND-TCS`, `IND-HDFCBANK`, `IND-NIFTY`, etc.), INR/mINR financial accounting, NSE market hours borrow windows (09:15–15:30 IST), and live Yahoo Finance Indian market feeds.
  - Comprehensive Arkiv implementation supporting all 7 entity types (`trade_journal`, `loan_memo`, `journal_note`, `user_profile`, `leaderboard_entry`, `session_snapshot`, `lend_event`), query operators, atomic batch writes with `predictEntityKeys`, and real-time WebSocket-to-SSE streaming.
  - Implementation and testing of `EqoraGame` (spot practice trading venue), `EqoraPool` (collateral-backed lending), `EqoraBorrowWindow` (NSE calendar guard), and `EqoraAssetGate` (circuit breaker).

---

## 3. Testnet Deployments & Public Access

### Polygon Amoy Testnet (Chain ID `80002`)
- **`EqoraPriceOracle`**: `0x67bA8AC8e5736dF9F1b03AF4B8139076892102fE`
- **`EqoraBorrowWindow`**: `0x566F545019614f001FFc832B7b02D5Cf10A4a720`
- **`EqoraAssetGate`**: `0xEd66BC73c45303a85Bf6D1cbc6bE110F65903AcF`
- **`EqoraMINR`**: `0x2619B11F344042fCED70F8ccDB9eF998A68b6D0D`
- **`EqoraPool`**: `0xDc67c69930d84E3eC5cE9e2386f464bB4391df3F`
- **`EqoraGame`**: `0x364Ac25908b00B26e7D6DDCa3dc5b7d38dDEC4bE`

### Arkiv Tiramisu Testnet (Chain ID `7738577`)
- **Service Wallet Address**: `0xD25F8736C3Efc19a7cb7A3D15f2aF22c2980E317`
- **Arkiv Explorer**: https://tiramisu.explorer.arkiv.network
- **Live Status Endpoint**: `GET /api/arkiv/status`

---

## 4. Key Arkiv Deliverables

1. **`arkiv/schema.md`**: Complete documentation of the 7 entity types, attribute types (`dec`, `i32`, `u64`, `u256`, `bytes32`, `addr`, `str`), query operators, flags, and payloads.
2. **`arkiv/friction.md`**: Detailed log of 15 documented integration hurdles, node error codes, and production workarounds shipped in the codebase.
3. **`arkiv/reproduction.md`**: Reproducible verification steps for the 39-step Arkiv test suite.
4. **Automated Smoke Test**: `npm run arkiv:smoke` executes 39 live testnet checks (entity CRUD, queries, batches, ownership, event watch).

---

## 5. Verification Checklist

- [x] MIT License in repository root.
- [x] Root `/arkiv/schema.md` present and synchronized.
- [x] Root `/arkiv/friction.md` present with verbatim node errors.
- [x] Documented wallet addresses creating entities on Tiramisu (`0xD25F8736C3Efc19a7cb7A3D15f2aF22c2980E317`).
- [x] Exact local setup and test reproduction steps.
- [x] Fresh build during hackathon window with zero pre-existing code ("Pre-existing work: None").
- [x] No secrets, private keys, or personal customer data in code or committed fixtures.
- [x] Working build and passing test suites across contracts, frontend, and backend.
