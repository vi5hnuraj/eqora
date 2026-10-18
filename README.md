# EQORA — Practice Indian Stocks. Prove It On-Chain.

> **Tagline:** *Trade. Lend. Prove it on-chain.*  
> **Testnet Notice:** Smart-contract trading and lending operate on **Polygon Amoy** (chain ID `80002`). The queryable activity journal operates on **Arkiv Tiramisu** (chain ID `7738577`). Synthetic instruments and demo mINR only — not a live brokerage, and no real equities or fiat rupees are involved.

---

## 1. What EQORA Does & The Problem It Solves

In India's rapidly growing retail trading landscape, millions of new investors enter the equity markets every year. However, learners face two critical problems:
1. **Financial Risk during Practice:** Practicing on live brokerages exposes retail investors to severe capital loss before they master risk management.
2. **The "Finfluencer" & Verification Problem:** Social media is flooded with fabricated profit screenshots, edited ledger PDFs, and unverifiable trading claims. Until now, there has been no decentralized, tamper-proof way to prove an authentic trading record.

**EQORA** bridges this gap:
- Traders practice spot buying and selling of top Indian equities (`IND-RELIANCE`, `IND-TCS`, `IND-HDFCBANK`, `IND-NIFTY`, etc.) against an on-chain automated venue (`EqoraGame`) using real-world market prices and mock Indian Rupees (`mINR`).
- Traders can supply their synthetic shares to `EqoraPool` to borrow against their holdings during National Stock Exchange (NSE) trading hours.
- **Unfakeable Journal Powered by Arkiv:** Every closed trade, loan memo, session snapshot, and trader note is recorded as a structured, queryable entity on **Arkiv Tiramisu**. Records carry cryptographic proofs, exact timestamps, and `{ readonly: true }` flags that neither the user nor platform administrators can alter or backdate.

---

## 2. System Architecture & Tech Stack

```text
eqora/
├── README.md                    # Canonical project documentation
├── LICENSE                      # MIT License
├── .gitignore                   # Git exclusion rules (safeguarding .env)
├── .env.example                 # Environment configuration template
├── package.json                 # Root script runner
├── scripts/
│   ├── check-env                # Environment & RPC verification script
│   ├── verify-project           # Full compilation & test runner
│   └── arkiv-smoke              # Live Arkiv Tiramisu integration runner
├── arkiv/
│   ├── schema.md                # 7 Arkiv entity schemas, query patterns & types
│   ├── friction.md              # 15 documented SDK/node integration findings
│   └── reproduction.md          # Step-by-step Arkiv test reproduction guide
├── docs/
│   ├── architecture.md          # End-to-end architecture & diagrams
│   ├── development.md           # Local development & setup guide
│   ├── deployment.md            # Deployed contracts & network configuration
│   ├── security.md              # Risk controls, circuit breakers & safeguards
│   └── submission.md            # Hackathon submission & provenance disclosure
├── contracts/                   # Solidity smart contracts & Hardhat tests
│   ├── src/                     # EqoraPool, EqoraGame, Oracle, BorrowWindow, etc.
│   ├── test/                    # 23 passing Hardhat unit tests
│   ├── scripts/                 # Deploy & liquidity funding scripts
│   └── deployments/             # Polygon Amoy deployment records
├── backend/                     # Node.js API & Arkiv Integration
│   ├── src/                     # Server, Arkiv service, Market reporter
│   └── .env.example             # Backend environment template
└── frontend/                    # Vite + React Terminal
    ├── src/                     # Trade, Lend, Portfolio, Activity, Explorer
    └── public/                  # Assets, Indian stock logos, SVG marks
```

- **Frontend**: Vite 5, React 18, Viem 2, TanStack Query 5, Lightweight Charts, Vanilla CSS.
- **Backend**: Node.js (≥22), Viem 2, `@arkiv-network/sdk` 0.8.1, Server-Sent Events (SSE).
- **Smart Contracts**: Solidity 0.8.27, OpenZeppelin Contracts 4.8.0, Hardhat.
- **Networks**: Polygon Amoy (80002) & Arkiv Tiramisu (7738577).

---

## 3. How Trading & Collateral Lending Work

### Spot Practice Trading (`EqoraGame`)
- Traders buy and sell synthetic Indian equity tokens using `mINR`.
- Trades execute against the oracle price with a transparent **0.30% venue fee**.
- The review modal enforces a user-defined slippage tolerance (minimum output parameter) to prevent frontrunning or execution against mid-flight price pushes.

### Collateral-Backed Lending (`EqoraPool`)
- Users supply synthetic stock tokens as collateral and borrow `mINR`.
- **Borrow Window (`EqoraBorrowWindow`)**: In accordance with Indian market reality, new borrowing is permitted exclusively during NSE market hours (**Monday–Friday, 09:15–15:30 IST**). Repayments are permitted 24/7.
- **Circuit Breaker (`EqoraAssetGate`)**: If an asset experiences a greater than 10% price shift within 60 minutes, borrowing against that specific asset is paused.
- **Risk Parameters**: LTV ratios (65%–75%), liquidation thresholds (75%–85%), and a 5% liquidator incentive.

---

## 4. Arkiv Integration & Entity Architecture

EQORA uses **Arkiv Tiramisu** as its decentralized record database. Seven entity types are actively maintained:

| Entity Type | Description | Key Attributes / Flags |
|---|---|---|
| `trade_journal` | Closed trade executions | `symbol`, `side`, `size`, `price`, `pnl_bps`, `size_wei`, `u64 created_ms`, `{ readonly: true, permissionlessExtension: true }` |
| `loan_memo` | Active collateral loan state | `user`, `collateral_sym`, `debt_minr`, `health_factor`, `status` |
| `journal_note` | Trader annotations & strategy notes | `trade_ref`, `note_hash`, `content`, user-signed via MetaMask |
| `user_profile` | Trader on-chain handle & profile | `handle`, `bio`, `twitter`, permanent lease |
| `leaderboard_entry` | Ranked performance snapshots | `score_bps`, `wins`, `trades`, `rank` |
| `session_snapshot` | Session summaries | Linked to trades via `predictEntityKeys` |
| `lend_event` | Mirrored pool operations | `op` (supply/borrow/repay/withdraw), `amount_wei` |

Full schema details are documented in [`arkiv/schema.md`](arkiv/schema.md).  
Engineering friction and workarounds are documented in [`arkiv/friction.md`](arkiv/friction.md).

---

## 5. Supported Indian Stock Instruments

Market data is scraped from Yahoo Finance for real-time NSE prices and pushed periodically by the reporter to `EqoraPriceOracle`:

| Instrument ID | Display Symbol | Company / Benchmark | Underlying NSE Ticker | Quote Currency |
|---|---|---|---|---|
| `IND-RELIANCE` | RELIANCE | Reliance Industries Ltd. | `RELIANCE.NS` | INR (₹) |
| `IND-TCS` | TCS | Tata Consultancy Services Ltd. | `TCS.NS` | INR (₹) |
| `IND-HDFCBANK` | HDFCBANK | HDFC Bank Ltd. | `HDFCBANK.NS` | INR (₹) |
| `IND-ICICIBANK` | ICICIBANK | ICICI Bank Ltd. | `ICICIBANK.NS` | INR (₹) |
| `IND-INFY` | INFY | Infosys Ltd. | `INFY.NS` | INR (₹) |
| `IND-HINDUNILVR` | HINDUNILVR | Hindustan Unilever Ltd. | `HINDUNILVR.NS` | INR (₹) |
| `IND-ITC` | ITC | ITC Ltd. | `ITC.NS` | INR (₹) |
| `IND-SBIN` | SBIN | State Bank of India | `SBIN.NS` | INR (₹) |
| `IND-BHARTIARTL` | BHARTIARTL | Bharti Airtel Ltd. | `BHARTIARTL.NS` | INR (₹) |
| `IND-LT` | LT | Larsen & Toubro Ltd. | `LT.NS` | INR (₹) |
| `IND-NIFTY` | NIFTY 50 | NIFTY 50 Index | `^NSEI` | INR (₹) |

*Data Source Limitation*: Market quotes reflect Yahoo Finance delayed/live public endpoints. Price pushes pause when markets are closed.

---

## 6. Quick Start & Local Setup

### Prerequisites
- Node.js ≥ 22.0.0
- npm ≥ 10.0.0

### Installation
```bash
# Clone the repository
git clone https://github.com/vi5hnuraj/eqora.git
cd eqora

# Install dependencies in contracts, backend, and frontend
(cd contracts && npm install)
(cd backend && npm install)
(cd frontend && npm install)

# Run environment check
./scripts/check-env
```

### Configure Environment
```bash
cp backend/.env.example backend/.env
# Edit backend/.env to add your service wallet PRIVATE_KEY
```

### Running Locally
```bash
# Terminal 1: Backend API & Reporter
cd backend
npm run dev

# Terminal 2: Frontend Web Terminal
cd frontend
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 7. Automated Testing & Verification

```bash
# 1. Run smart contract unit tests (23 tests)
npm test

# 2. Build frontend production bundle
npm run build

# 3. Run live Arkiv Tiramisu smoke test (39 integration tests)
npm run arkiv:smoke

# 4. Run full project verification
./scripts/verify-project
```

---

## 8. Hackathon Submission & Deliverables

- **Challenge**: Arkiv Global Tour Stop
- **Tracks**:
  - **Primary**: Best Indian Use Case
  - **Secondary**: Open Source
- **Submission Details**: Full submission checklist and architecture overview documented in [`docs/submission.md`](docs/submission.md).
- **Arkiv Deliverables**: Root [`arkiv/schema.md`](arkiv/schema.md), [`arkiv/friction.md`](arkiv/friction.md), and [`arkiv/reproduction.md`](arkiv/reproduction.md).

---

## 9. Security & Safety

- Backend private keys are never exposed to browser clients.
- Error messages automatically redact access keys and RPC credentials.
- Real `.env` files are gitignored.
- See [`docs/security.md`](docs/security.md) for complete details.

---

## 10. License

This project is licensed under the **MIT License** — see [LICENSE](LICENSE) for details.  
Third-party notices: [contracts/THIRD_PARTY_NOTICES.md](contracts/THIRD_PARTY_NOTICES.md).
