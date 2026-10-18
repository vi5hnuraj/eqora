import { createPublicClient, createWalletClient, defineChain, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, oracleAddress } from "./config.js";

export const amoy = defineChain({
  id: 80002,
  name: "Polygon Amoy",
  nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
  rpcUrls: { default: { http: [config.amoyRpcUrl] } },
  blockExplorers: { default: { name: "PolygonScan", url: "https://amoy.polygonscan.com" } },
  testnet: true,
});

export const ORACLE_ABI = [
  {
    name: "setPrice",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "symbol", type: "string" },
      { name: "price", type: "int256" },
    ],
    outputs: [],
  },
  {
    name: "getRawPrice",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "symbol", type: "string" }],
    outputs: [
      { name: "price", type: "int256" },
      { name: "updatedAt", type: "uint64" },
    ],
  },
];

// Full NSE watchlist for the ticker + charts (Yahoo-backed, no gas cost).
export const WATCH_SYMBOLS = {
  "IND-RELIANCE": "RELIANCE.NS",
  "IND-TCS": "TCS.NS",
  "IND-HDFCBANK": "HDFCBANK.NS",
  "IND-ICICIBANK": "ICICIBANK.NS",
  "IND-INFY": "INFY.NS",
  "IND-HINDUNILVR": "HINDUNILVR.NS",
  "IND-ITC": "ITC.NS",
  "IND-SBIN": "SBIN.NS",
  "IND-BHARTIARTL": "BHARTIARTL.NS",
  "IND-LT": "LT.NS",
  "IND-NIFTY": "^NSEI",
};

// Only symbols with a deployed collateral token + oracle entry get on-chain
// price pushes. Pushing all 10 would burn gas for no lending benefit.
// Derived from the deployment file so tokens added by add-stocks.js are
// reported automatically (fallback: the original six).
export const ORACLE_SYMBOLS = (() => {
  const deployed = Object.keys(config.deployment?.contracts ?? {})
    .filter((k) => k.startsWith("IND-"));
  return deployed.length
    ? deployed
    : [
        "IND-RELIANCE", "IND-TCS", "IND-NIFTY",
        "IND-HDFCBANK", "IND-ICICIBANK", "IND-INFY",
      ];
})();

export const SYMBOLS = WATCH_SYMBOLS;

export const priceCache = {};

const ERC20_ABI = [
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

// Practice-terminal buy: the service wallet (token owner) mints shares to
// the buyer on Amoy, then the caller journals the ticket to Arkiv.
export async function mintShares(to, symbol, shares) {
  const token = config.deployment?.contracts?.[symbol];
  if (!token) throw new Error(`no deployed token for ${symbol}`);
  const amount = BigInt(Math.round(Number(shares) * 1e18));
  if (amount <= 0n) throw new Error("shares must be > 0");

  const wallet = amoyWallet();
  const client = amoyPublic();

  // Amoy public RPCs reject EIP-1559 raw txs ("Missing or invalid parameters")
  // — legacy type-0 with the node's gasPrice always goes through.
  const gas = 55_000n;
  const gasPrice = await client.getGasPrice();
  const balance = await client.getBalance({ address: wallet.account.address });
  const cost = gas * gasPrice;
  if (cost + gasPrice > balance) {
    throw new Error(
      `service wallet POL too low for a mint (has ${formatEther(balance)} POL, need ~${formatEther(cost)}) — top up ${wallet.account.address} on Amoy`
    );
  }

  const data = `0x40c10f19${to.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
  const hash = await wallet.sendTransaction({
    to: token,
    data,
    gas,
    gasPrice,
    chain: amoy,
    type: "legacy",
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error("mint tx reverted");
  return { txHash: hash, token, amount: String(amount) };
}

function amoyPublic() {
  return createPublicClient({ chain: amoy, transport: http(config.amoyRpcUrl) });
}

function amoyWallet() {
  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY missing — copy backend/.env.example to backend/.env");
  }
  return createWalletClient({
    chain: amoy,
    transport: http(config.amoyRpcUrl),
    account: privateKeyToAccount(config.privateKey),
  });
}

export async function fetchYahooPrice(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?interval=1d&range=1d`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
  });
  if (!response.ok) {
    throw new Error(`Yahoo ${ticker} HTTP ${response.status}`);
  }
  const body = await response.json();
  const meta = body?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice ?? meta?.chartPreviousClose;
  if (typeof price !== "number" || !(price > 0)) {
    throw new Error(`Yahoo ${ticker}: no price in response`);
  }
  return {
    ticker,
    price,
    currency: meta.currency ?? "INR",
    marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

export function toOraclePrice(priceRupees) {
  return BigInt(Math.round(priceRupees * 1e8));
}

export async function fetchAllPrices() {
  const entries = await Promise.all(
    Object.entries(SYMBOLS).map(async ([symbol, ticker]) => {
      const quote = await fetchYahooPrice(ticker);
      const record = {
        symbol,
        ticker,
        price: quote.price,
        currency: quote.currency,
        marketTime: quote.marketTime,
        updatedAt: Date.now(),
      };
      priceCache[symbol] = record;
      return record;
    })
  );
  return entries;
}

const IST_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kolkata",
  hour12: false,
  hourCycle: "h23",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function marketOpenIST(now = new Date()) {
  const parts = Object.fromEntries(
    IST_FORMAT.formatToParts(now).map((part) => [part.type, part.value])
  );
  const weekdays = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5 };
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = weekdays[parts.weekday] !== undefined;
  const open = minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
  return { open: weekday && open, at: `${parts.weekday} ${parts.hour}:${parts.minute} IST` };
}

const lastPushed = {};
// The venue refuses quotes older than 6h — re-push at 4h even if unmoved
// so weekend (closed-market) prices never go stale. The on-chain updatedAt
// is the source of truth so this survives backend restarts.
const REFRESH_MS = 4 * 3600_000;

export async function pushPrices({ force = false } = {}) {
  const oracle = oracleAddress();
  const wallet = amoyWallet();
  const client = amoyPublic();
  const hashes = [];

  // Hard floor: never spend the wallet below this. The reporter used to drain
  // the account to zero on gas spikes — refuse to send anything once the
  // balance is under the floor so the owner decides when to refill.
  const floor = BigInt(process.env.POL_FLOOR_WEI || 10_000_000_000_000_000n); // 0.01 POL
  const bal = await client.getBalance({ address: wallet.account.address });
  if (bal < floor) {
    return ORACLE_SYMBOLS.map((symbol) => ({
      symbol,
      skipped: true,
      reason: `POL balance too low (${formatEther(bal)} < ${formatEther(floor)})`,
    }));
  }

  for (const symbol of ORACLE_SYMBOLS) {
    const ticker = WATCH_SYMBOLS[symbol];
    let quote;
    try {
      quote = await fetchYahooPrice(ticker);
    } catch (error) {
      hashes.push({ symbol, skipped: true, reason: error.message });
      continue;
    }

    // Skip tiny moves so we don't burn gas on noise — unless the on-chain
    // price is old enough that the venue's staleness window would cut off
    // trading.
    const prev = lastPushed[symbol];
    const moved = prev == null || Math.abs(quote.price - prev) / prev > 0.001;
    let stale = false;
    try {
      const [, updatedAt] = await client.readContract({
        address: oracle,
        abi: ORACLE_ABI,
        functionName: "getRawPrice",
        args: [symbol],
      });
      stale = Number(updatedAt) === 0 || Date.now() / 1000 - Number(updatedAt) > REFRESH_MS / 1000;
    } catch { stale = true; }
    if (!force && !moved && !stale) {
      hashes.push({ symbol, skipped: true, reason: "no material move" });
      continue;
    }

    try {
      // Estimate EIP-1559 fees from the node, but cap them so a gas spike
      // can never drain the wallet (the bug that emptied it before).
      const fee = await client.estimateFeesPerGas().catch(() => null);
      const cap = BigInt(Number(process.env.AMOY_MAX_FEE || 60_000_000_000)); // 60 gwei hard cap
      let maxFee = fee?.maxFeePerGas ?? cap;
      let maxPriority = fee?.maxPriorityFeePerGas ?? 1_000_000_000n;
      if (maxFee > cap) maxFee = cap;
      if (maxPriority > maxFee) maxPriority = maxFee;

      const txHash = await wallet.writeContract({
        address: oracle,
        abi: ORACLE_ABI,
        functionName: "setPrice",
        args: [symbol, toOraclePrice(quote.price)],
        gas: 150_000n, // oracle + gate.recordPrice callback needs ~92k; leave headroom
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: maxPriority,
      });
      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      lastPushed[symbol] = quote.price;
      lastPushAt[symbol] = Date.now();
      hashes.push({ symbol, price: quote.price, txHash, status: receipt.status });
    } catch (error) {
      hashes.push({ symbol, skipped: true, reason: error.shortMessage || error.message });
    }
  }
  return hashes;
}

export async function readOnChainPrices() {
  const oracle = oracleAddress();
  const client = amoyPublic();

  // Warm the Yahoo cache for the full watchlist (no gas) so every symbol in
  // the ticker has a live price, even the 7 that aren't collateral tokens.
  try {
    await fetchAllPrices();
  } catch { /* keep whatever cache we have */ }

  const results = await Promise.all(
    Object.keys(WATCH_SYMBOLS).map(async (symbol) => {
      // Collateral tokens prefer the on-chain oracle (what the pool prices at).
      if (ORACLE_SYMBOLS.includes(symbol)) {
        try {
          const [price, updatedAt] = await client.readContract({
            address: oracle,
            abi: ORACLE_ABI,
            functionName: "getRawPrice",
            args: [symbol],
          });
          if (Number(price) > 0) {
            return {
              symbol,
              price: Number(price) / 1e8,
              updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
              onChain: true,
            };
          }
        } catch { /* fall through to Yahoo */ }
      }
      return priceCache[symbol]
        ? { ...priceCache[symbol], onChain: false }
        : { symbol, price: null, onChain: false };
    })
  );
  return results;
}

export function reporterIntervalMs() {
  const { open } = marketOpenIST();
  // Every 3 min while open, every 30 min otherwise. The old 1-min cadence
  // drained the wallet (~1,100 txs/day).
  return open ? 3 * 60_000 : 30 * 60_000;
}

const CANDLE_SPECS = {
  "5m": { interval: "5m", range: "1d" },
  "15m": { interval: "15m", range: "5d" },
  "1h": { interval: "60m", range: "1mo" },
  "4h": { interval: "60m", range: "3mo", group: 4 },
  "1d": { interval: "1d", range: "6mo" },
  "1w": { interval: "1wk", range: "2y" },
  "1mo": { interval: "1mo", range: "max" },
};

function downsample(candles, n) {
  const out = [];
  let i = 0;
  while (i < candles.length) {
    const day = Math.floor(candles[i].time / 86400);
    const bars = [];
    while (i < candles.length && Math.floor(candles[i].time / 86400) === day) {
      bars.push(candles[i]);
      i++;
    }
    for (let j = 0; j < bars.length; j += n) {
      const chunk = bars.slice(j, j + n);
      out.push({
        time: chunk[0].time,
        open: chunk[0].open,
        high: Math.max(...chunk.map((c) => c.high)),
        low: Math.min(...chunk.map((c) => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((s, c) => s + (c.volume || 0), 0),
      });
    }
  }
  return out;
}

export async function fetchCandles(symbol, timeframe = "1d") {
  const ticker = SYMBOLS[symbol] || symbol;
  const spec = CANDLE_SPECS[timeframe] || CANDLE_SPECS["1d"];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?interval=${spec.interval}&range=${spec.range}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
  });
  if (!response.ok) throw new Error(`Yahoo candles ${ticker} HTTP ${response.status}`);
  const body = await response.json();
  const result = body?.chart?.result?.[0];
  const stamps = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  let candles = [];
  for (let i = 0; i < stamps.length; i++) {
    const open = q.open?.[i], high = q.high?.[i], low = q.low?.[i], close = q.close?.[i];
    const volume = q.volume?.[i] ?? 0;
    if (open == null || high == null || low == null || close == null) continue;
    candles.push({ time: stamps[i], open, high, low, close, volume });
  }
  if (spec.group > 1) candles = downsample(candles, spec.group);
  return { symbol, ticker, timeframe, interval: spec.interval, range: spec.range, candles };
}
