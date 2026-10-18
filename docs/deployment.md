# EQORA — Deployment & Network Guide

This document lists deployed contracts, network endpoints, deployment scripts, and testnet limitations.

## 1. Network Information

### Primary Application Chain: Polygon Amoy Testnet
- **Chain ID**: `80002` (`0x13882`)
- **Network Name**: Polygon Amoy
- **Native Currency**: POL (18 decimals)
- **Public RPC**: `https://polygon-amoy-bor-rpc.publicnode.com`
- **Block Explorer**: [PolygonScan Amoy](https://amoy.polygonscan.com)

### Record & Activity Layer: Arkiv Tiramisu Testnet
- **Chain ID**: `7738577` (`0x7614d1`)
- **Network Name**: Arkiv Tiramisu
- **Native Currency**: GLM (18 decimals)
- **HTTP RPC**: `https://rpc.tiramisu.db-chain.testnet.arkiv.network`
- **WebSocket RPC**: `wss://rpc.tiramisu.db-chain.testnet.arkiv.network`
- **Block Explorer**: [Arkiv Tiramisu Explorer](https://tiramisu.explorer.arkiv.network)
- **Gas / Faucet Hub**: [Arkiv Hub](https://hub.arkiv.network)

---

## 2. Deployed Contracts (Polygon Amoy)

All contracts have been compiled with Hardhat / Solidity `0.8.27` and deployed from deployer address:
`0xD25F8736C3Efc19a7cb7A3D15f2aF22c2980E317`.

| Contract | Address on Polygon Amoy | Description |
|---|---|---|
| **`EqoraPriceOracle`** | `0x67bA8AC8e5736dF9F1b03AF4B8139076892102fE` | On-chain 8-decimal stock price oracle |
| **`EqoraBorrowWindow`** | `0x566F545019614f001FFc832B7b02D5Cf10A4a720` | NSE trading window guard (09:15–15:30 IST) |
| **`EqoraAssetGate`** | `0xEd66BC73c45303a85Bf6D1cbc6bE110F65903AcF` | 10% 1-hour jump circuit breaker |
| **`EqoraMINR`** | `0x2619B11F344042fCED70F8ccDB9eF998A68b6D0D` | Practice Indian Rupees with 10k faucet |
| **`EqoraPool`** (`Pool`) | `0xDc67c69930d84E3eC5cE9e2386f464bB4391df3F` | Overcollateralized lending & borrowing pool |
| **`EqoraGame`** (`Game`) | `0x364Ac25908b00B26e7D6DDCa3dc5b7d38dDEC4bE` | Spot trading practice venue |

### Synthetic Indian Stock Tokens:

| Symbol | Address on Polygon Amoy | Underlying Company / Instrument |
|---|---|---|
| `IND-RELIANCE` | `0xCE09B893ae259090b51F19337DF6F93cb1713DaA` | Reliance Industries Ltd. |
| `IND-TCS` | `0x775Ab463A19E51072C61bAe94A0931E00F7caa42` | Tata Consultancy Services Ltd. |
| `IND-HDFCBANK` | `0xB5df2dF01A292AD08c96d70a6691a7233b086102` | HDFC Bank Ltd. |
| `IND-ICICIBANK` | `0xfA1Aad0D6cE0a64C9D05670bde98aCeF92a51A8A` | ICICI Bank Ltd. |
| `IND-INFY` | `0xb7D6985662609ce55adBEa3cc9eBE0B58f81369A` | Infosys Ltd. |
| `IND-HINDUNILVR` | `0xa65147D2328e99940387dE2a7F33fb7dEe133F6B` | Hindustan Unilever Ltd. |
| `IND-ITC` | `0x53238cd2ad9228008B3627C59a98FdFE87cB814F` | ITC Ltd. |
| `IND-SBIN` | `0xB6E9F3c66A8C9700A0C9E588e3Edb19448854698` | State Bank of India |
| `IND-BHARTIARTL` | `0xBF7605eaaAe4326Aa5C41Da6750F10E08389a4cc` | Bharti Airtel Ltd. |
| `IND-LT` | `0xc2172D2F6C435540E03bA2954052866c5a973f89` | Larsen & Toubro Ltd. |
| `IND-NIFTY` | `0x8Ee56764A2D91b8ac5C00D87f0261Cace0036Fa9` | NIFTY 50 Benchmark Index |

Deployment metadata is preserved in [`contracts/deployments/polygonAmoy.json`](file:///contracts/deployments/polygonAmoy.json).

---

## 3. Deployment Scripts

In `contracts/scripts/`:
- **`deploy.js`**: Deploys the full contract suite (Oracle, BorrowWindow, AssetGate, MINR, Pool, Stock tokens, and Game), wires permissions, and saves `polygonAmoy.json`.
- **`add-stocks.js`**: Extends the deployment by deploying additional Indian stock tokens and registering them with the oracle and pool.
- **`fund-game.js`**: Funds the `EqoraGame` venue with inventory and mINR reserves for spot trading liquidity.

---

## 4. Testnet Limitations & Honest Disclosures

1. **Testnet Implementation**: All workflows operate on the Polygon Amoy and Arkiv Tiramisu testnets.
2. **Synthetic Instruments**: Stock tokens are synthetic demo tokens with prices pegged to real-world Indian market quotes via Yahoo Finance. They do **not** represent real equity ownership, shares in registered Indian companies, or SEBI-regulated instruments.
3. **No Real Financial Custody**: mINR is a demo ERC-20 token for practice without financial value.
