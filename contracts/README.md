# EQORA contracts

Solidity 0.8.27 (Hardhat, OpenZeppelin 4.8.0) contracts for the EQORA practice terminal on **Polygon Amoy** (chain 80002).

| Contract | Role |
| --- | --- |
| `EqoraPool.sol` | Supply / withdraw / borrow / repay demo mINR against tokenized-stock collateral |
| `EqoraPriceOracle.sol` | 8-decimal INR price feeds with pusher role + staleness checks |
| `EqoraStockToken.sol` | Synthetic NSE share (18 decimals, demo flag) |
| `EqoraMINR.sol` | Demo INR stablecoin used for settlement |
| `EqoraAssetGate.sol` | Per-asset borrow gate (pause/limits by owner) |
| `EqoraBorrowWindow.sol` | Market-session borrow windows (IST sessions, weekends closed) |
| `EqoraGame.sol` | Instant-spot venue: mINR ↔ synthetic shares at oracle price, 0.30% fee, slippage-protected quotes |

## Reproduce locally

```sh
npm install
npm run compile
npm test
```

Tests run on Hardhat's in-process chain — no RPC credentials or funded keys required. Deployment lives in `scripts/deploy.js` (resumable, gas-capped) and writes `deployments/polygonAmoy.json`.
