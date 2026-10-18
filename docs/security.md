# EQORA — Security & Risk Management Architecture

This document describes the security controls, validation checks, and risk-mitigation measures implemented in EQORA across smart contracts, the backend service, frontend terminal, and Arkiv record layer.

---

## 1. Smart Contract Controls

### 1.1 Price Staleness & Oracle Protections (`EqoraPriceOracle`)
- **Staleness Threshold**: Prices carry a block timestamp `updatedAt`. If `block.timestamp - updatedAt > 24 hours`, borrow operations revert with `PriceStale()`.
- **Authorized Reporter**: Only the contract owner / designated reporter can invoke `setPrice`.
- **Zero / Negative Value Rejection**: The oracle reverts on invalid or non-positive values.

### 1.2 Time-Based Borrow Restrictions (`EqoraBorrowWindow`)
- **NSE Trading Calendar**: Collateral-backed borrowing is permitted only during active National Stock Exchange (NSE) cash market hours (Monday–Friday, 09:15–15:30 IST).
- **Repayment Exemption**: Users can always repay debt and withdraw excess collateral at any time, 24/7, even when markets are closed.

### 1.3 Circuit Breaker & Jump Protection (`EqoraAssetGate`)
- **10% 1-Hour Jump Barrier**: If the price of an asset changes by more than 10% within a rolling 60-minute window, borrowing against that specific asset is automatically paused.
- **Granular Pause**: Only the affected collateral token is gated; unaffected tokens continue trading.

### 1.4 Lending Pool Risk Parameters (`EqoraPool`)
- **Loan-to-Value (LTV)**: Capped strictly per asset (65% to 75%).
- **Liquidation Threshold**: Fixed between 75% and 85%.
- **Liquidation Bonus**: 5% reward to third-party liquidators who repay unhealthy debt positions.
- **Accrual Integrity**: Interest accrues per-second using normalized debt indexes with safe integer arithmetic.

### 1.5 Spot Slippage Protection (`EqoraGame`)
- **Minimum Output Parameter**: Every spot buy and sell transaction accepts a `minShares` or `minMInr` argument calculated from user-reviewed slippage settings.
- **Reversion on Inadequate Liquidity**: The venue fails loudly if reserves or inventory are insufficient.

---

## 2. Arkiv Record Layer & Key Management

### 2.1 Backend Private Key Isolation
- The backend's service wallet private key (`PRIVATE_KEY`) is used strictly server-side for publishing oracle updates on Amoy and initial journal records on Tiramisu.
- **Never sent to the client**: The browser has zero access to backend keys.
- **Direct User Signing**: Traders sign their own notes (`journal_note`) and profiles (`user_profile`) directly in MetaMask on Tiramisu using the `@arkiv-network/sdk`.

### 2.2 Error Sanitization & Secret Redaction
- In `backend/src/server.js`, outgoing error messages are passed through `errMsg()`, which automatically scrubs any URL paths containing access keys (`ark_live_...` -> `ark_live_…(redacted)`).
- Environment files (`.env`) are strictly gitignored and excluded from client bundles.

### 2.3 Record Immutability & Permissions
- `trade_journal` entities are minted with flags `{ readonly: true, permissionlessExtension: true }` (raw flags `3`).
- The payload and trade metrics cannot be altered or overwritten by anyone (including the backend service) after creation.
- Anyone can permissionlessly extend the lease so historical performance records do not expire prematurely.

---

## 3. Frontend Terminal Safety

- **Dynamic Fee Capping**: Amoy transactions are capped at 60 gwei with a 25 gwei priority fee minimum to guard against network fee spikes while avoiding dropped transactions.
- **Revert Clarification**: If a transaction reverts, the user interface parses the revert reason and presents actionable feedback rather than cryptic errors.
- **Dual Currency Transparency**: The ₹ INR / $ USD currency toggle clearly specifies that display conversions are purely visual and that all smart contract accounting and settlement remains in INR / mINR.
