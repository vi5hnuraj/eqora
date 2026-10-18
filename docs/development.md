# EQORA — Local Development Guide

This guide walks you through setting up, running, testing, and debugging the EQORA codebase locally.

## 1. Prerequisites

- **Node.js**: Version ≥ 22.0.0 (Node 22 LTS or newer recommended)
- **Package Manager**: `npm`
- **Wallet**: MetaMask or compatible EVM browser wallet
- **Git**: For version control

---

## 2. Quick Setup

Clone the repository and install dependencies for all modules:

```bash
# 1. Install dependencies in all subpackages
(cd contracts && npm install)
(cd backend && npm install)
(cd frontend && npm install)

# 2. Run the environment verification script
./scripts/check-env
```

---

## 3. Environment Configuration

### Backend Configuration
Copy `backend/.env.example` to `backend/.env`:

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`:
- `PRIVATE_KEY`: Service wallet private key (used for oracle price updates on Amoy and creating Arkiv records on Tiramisu).
- `AMOY_RPC_URL`: `https://polygon-amoy-bor-rpc.publicnode.com` (or your private RPC endpoint).
- `TIRAMISU_RPC_URL`: `https://rpc.tiramisu.db-chain.testnet.arkiv.network`.
- `TIRAMISU_ACCESS_KEY`: (Optional) Free access key from [hub.arkiv.network](https://hub.arkiv.network).
- `PORT`: `8787`.

---

## 4. Running the Development Services

### Running the Backend:
```bash
cd backend
npm run dev
# Or start full stack (server + price reporter):
npm start
```
The HTTP API will be accessible at `http://localhost:8787`.

### Running the Frontend:
```bash
cd frontend
npm run dev
```
The React terminal will be accessible at `http://localhost:5173`.

---

## 5. Testing & Verification

EQORA includes automated verification tools to ensure all layers function properly:

### 1. Smart Contract Test Suite
```bash
# In contracts directory or repo root:
npm test
# Or:
cd contracts && npx hardhat test
```
Runs 23 comprehensive tests covering:
- Spot trading and slippage control (`EqoraGame`).
- Borrow window market hours (`EqoraBorrowWindow`).
- Collateral supply, borrowing, and interest accrual (`EqoraPool`).
- Circuit breaker price jumps (`EqoraAssetGate`).
- Liquidations and faucet claims.

### 2. Frontend Production Build
```bash
npm run build
# Or:
cd frontend && npm run build
```
Validates TypeScript/JSX bundling, asset imports, and styles with zero errors.

### 3. Arkiv Tiramisu Smoke Test
```bash
npm run arkiv:smoke
# Or:
./scripts/arkiv-smoke
```
Executes 39 live integration tests on the Arkiv Tiramisu testnet verifying all entity types, range queries, batch atomic transactions, and event streams.

### 4. Full Project Verification
```bash
./scripts/verify-project
```
Runs contract compilation, test suites, and frontend build in one command.
