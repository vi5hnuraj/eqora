export const POOL_ABI = [
  { type: "function", name: "accountData", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "collateralValue", type: "uint256" },
      { name: "debt", type: "uint256" },
      { name: "health", type: "uint256" },
    ] },
  { type: "function", name: "healthFactor", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "debtOf", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "borrowingPower", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "collateralOf", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }, { name: "underlying", type: "address" }],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "collateralValueOf", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }, { name: "underlying", type: "address" }],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "assets", stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "supported", type: "bool" },
      { name: "ltvBps", type: "uint16" },
      { name: "liqThresholdBps", type: "uint16" },
      { name: "symbol", type: "string" },
    ] },
  { type: "function", name: "minr", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "supply", stateMutability: "nonpayable",
    inputs: [{ name: "underlying", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "borrow", stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "repay", stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable",
    inputs: [{ name: "underlying", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "collateralTotal", stateMutability: "view",
    inputs: [{ name: "underlying", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalDebtNormalized", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "index", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "currentIndex", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "borrowRateBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "priceOf", stateMutability: "view",
    inputs: [{ name: "underlying", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "event", name: "Supply", inputs: [
    { name: "user", type: "address", indexed: true },
    { name: "underlying", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false } ] },
  { type: "event", name: "Borrow", inputs: [
    { name: "user", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false } ] },
  { type: "event", name: "Repay", inputs: [
    { name: "user", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false } ] },
];

export const TOKEN_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

export const MINR_ABI = [
  { type: "function", name: "faucet", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

// EqoraGame — the spot venue: quote in, review, then one wallet confirmation.
export const GAME_ABI = [
  { type: "function", name: "quoteBuy", stateMutability: "view",
    inputs: [{ name: "stock", type: "address" }, { name: "minrAmount", type: "uint256" }],
    outputs: [{ name: "shares", type: "uint256" }, { name: "price", type: "uint256" }] },
  { type: "function", name: "quoteSell", stateMutability: "view",
    inputs: [{ name: "stock", type: "address" }, { name: "shares", type: "uint256" }],
    outputs: [{ name: "minrOut", type: "uint256" }, { name: "price", type: "uint256" }] },
  { type: "function", name: "buyStock", stateMutability: "nonpayable",
    inputs: [
      { name: "stock", type: "address" },
      { name: "minrAmount", type: "uint256" },
      { name: "minShares", type: "uint256" },
    ], outputs: [{ name: "shares", type: "uint256" }] },
  { type: "function", name: "sellStock", stateMutability: "nonpayable",
    inputs: [
      { name: "stock", type: "address" },
      { name: "shares", type: "uint256" },
      { name: "minMInr", type: "uint256" },
    ], outputs: [{ name: "minrOut", type: "uint256" }] },
  { type: "function", name: "inventoryOf", stateMutability: "view",
    inputs: [{ name: "stock", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "reserveBalance", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
];


export const ORACLE_ABI = [
  { type: "function", name: "getRawPrice", stateMutability: "view",
    inputs: [{ name: "symbol", type: "string" }],
    outputs: [{ name: "price", type: "int256" }, { name: "updatedAt", type: "uint64" }] },
];

export const WINDOW_ABI = [
  { type: "function", name: "canBorrow", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
];

export const GATE_ABI = [
  { type: "function", name: "isPaused", stateMutability: "view",
    inputs: [{ name: "symbol", type: "string" }], outputs: [{ type: "bool" }] },
];
