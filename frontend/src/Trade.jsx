import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createChart, ColorType } from "lightweight-charts";
import { formatUnits } from "viem";
import { SYMBOLS, LENDABLE, CONTRACTS } from "./config.js";
import { getCandles, createJournal, listJournal } from "./api.js";
import { fmtInr, fmtToken, fmtHealth, healthClass, toToken } from "./format.js";
import { useCurrency } from "./currency.jsx";
import AssetIcon from "./AssetIcon.jsx";

const RANGES = [
  { key: "5m", label: "5m" },
  { key: "15m", label: "15m" },
  { key: "1h", label: "1H" },
  { key: "4h", label: "4H" },
  { key: "1d", label: "1D" },
  { key: "1w", label: "1W" },
  { key: "1mo", label: "1M" },
];

const INTRADAY = new Set(["5m", "15m", "1h", "4h"]);

// 0.30% venue fee is already inside the quote; 0.50% slippage guard goes on
// the on-chain call as a minimum output so a price push mid-review can't
// deliver a worse fill than the ticket promised.
const SLIPPAGE_BPS = 50n;
const FEE_BPS = 30n;
const BPS = 10_000n;
const QUOTE_TTL_MS = 20_000; // review modal quotes live 20s

const errMsg = (e) => {
  const m = e?.shortMessage || e?.details || e?.message || String(e);
  // Viem puts the revert reason on the line after "…reverted with the following reason:"
  const lines = m.split("\n").map((l) => l.trim()).filter(Boolean);
  const reason = lines.length > 1 ? lines[lines.length - 1] : lines[0];
  return (reason || m).slice(0, 140);
};

export default function Trade({ wallet, prices, refreshKey, onToast }) {
  const { account, contracts } = wallet;
  const { currency, symbol: curSym } = useCurrency();
  const navigate = useNavigate();
  const chartEl = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const [symbol, setSymbol] = useState(SYMBOLS[0]);
  const [rangeKey, setRangeKey] = useState("1d");
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(false);

  // Trade type: spot | leverage
  const [tradeType, setTradeType] = useState("spot");
  // Spot side
  const [side, setSide] = useState("buy");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  // Leverage params
  const [leverage, setLeverage] = useState(2);
  const [slPct, setSlPct] = useState(-10);
  const [tpPct, setTpPct] = useState(100);
  const [busy, setBusy] = useState(false);
  const session = useRef(`t-${Date.now().toString(36)}`);

  // Position data for the selected asset + mINR balance
  const [pos, setPos] = useState({ wallet: 0n, supplied: 0n, suppliedValue: 0n, debt: 0n, health: null, power: 0n, collateralValue: 0n, borrowApr: 0 });
  const [minrBal, setMinrBal] = useState(0n);
  // Chart card view: "chart" | "positions"
  const [cardView, setCardView] = useState("chart");

  // --- spot quote / review state ---
  const [quote, setQuote] = useState(null); // { amountIn, amountOut, price, at }
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState(null);
  const [review, setReview] = useState(null); // frozen quote snapshot for the modal
  const [reviewAt, setReviewAt] = useState(0);
  const [stage, setStage] = useState(null); // wallet step label while busy
  const [clock, setClock] = useState(Date.now());

  const tokenAddr = CONTRACTS.tokens[symbol];
  const ticker = symbol.replace("IND-", "");
  const spotLive = Boolean(CONTRACTS.game && contracts.game);

  const currentPrice = prices.find((p) => p.symbol === symbol)?.price || 0;
  const prevPrice = useRef(currentPrice);
  const change = currentPrice && prevPrice.current ? ((currentPrice - prevPrice.current) / prevPrice.current) * 100 : 0;

  const loadCandles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getCandles(symbol, rangeKey);
      setCandles(data.candles || []);
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally { setLoading(false); }
  }, [symbol, rangeKey, onToast]);

  useEffect(() => { loadCandles(); }, [loadCandles]);

  // Track previous price for change calc
  useEffect(() => {
    if (currentPrice) prevPrice.current = currentPrice;
  }, [currentPrice]);

  // Init chart once
  useEffect(() => {
    if (!chartEl.current) return;
    const chart = createChart(chartEl.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#a899d4",
        fontFamily: "SF Mono, ui-monospace, Menlo, monospace",
      },
      grid: { vertLines: { color: "rgba(124,58,237,.12)" }, horzLines: { color: "rgba(124,58,237,.12)" } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "rgba(255,255,255,.1)", scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: {
        borderColor: "rgba(255,255,255,.1)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        tickMarkFormatter: (time) => {
          const d = new Date(time * 1000);
          if (INTRADAY.has(rangeKey)) {
            return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          }
          if (rangeKey === "1w") {
            return `${d.getDate()}/${d.getMonth() + 1}`;
          }
          if (rangeKey === "1mo") {
            return `${d.toLocaleString("en", { month: "short" })} '${String(d.getFullYear()).slice(2)}`;
          }
          return `${d.getDate()}/${d.getMonth() + 1}`;
        },
      },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#f6c94c", downColor: "#ff5f9e",
      borderVisible: false,
      wickUpColor: "#f6c94c", wickDownColor: "#ff5f9e",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    const volumeSeries = chart.addHistogramSeries({
      color: "#f6c94c",
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    chartRef.current = chart;
    seriesRef.current = series;
    chartRef.current._volumeSeries = volumeSeries;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, [rangeKey]);

  // Set candle + volume data, then fit content to remove empty gap
  useEffect(() => {
    if (!chartRef.current || !seriesRef.current || !candles.length) return;
    const data = candles.map((c) => ({ ...c, time: Number(c.time) }));
    seriesRef.current.setData(data);
    const vol = chartRef.current._volumeSeries;
    if (vol) {
      vol.setData(data.map((c) => ({
        time: c.time,
        value: c.volume || 0,
        color: c.close >= c.open ? "rgba(246,201,76,.3)" : "rgba(255,95,158,.3)",
      })));
    }
    chartRef.current.timeScale().fitContent();
  }, [candles]);

  // Live-update the forming candle with the oracle price
  useEffect(() => {
    if (!seriesRef.current || !candles.length || !currentPrice) return;
    const last = candles[candles.length - 1];
    seriesRef.current.update({
      time: Number(last.time),
      open: last.open, high: Math.max(last.high, currentPrice),
      low: Math.min(last.low, currentPrice), close: currentPrice,
    });
  }, [currentPrice, candles]);

  // Load position data + mINR balance (only for tokens with an on-chain contract)
  const loadPos = useCallback(async () => {
    if (!account) return;
    const addr = CONTRACTS.tokens[symbol];
    if (!addr) { setPos(null); return; }
    try {
      const reads = [
        contracts.token(addr).read("balanceOf", [account]),
        contracts.pool.read("collateralOf", [account, addr]),
        contracts.pool.read("collateralValueOf", [account, addr]),
        contracts.pool.read("debtOf", [account]),
        contracts.pool.read("healthFactor", [account]),
        contracts.pool.read("borrowingPower", [account]),
        contracts.pool.read("accountData", [account]).then((a) => a[0]),
        contracts.minr.read("balanceOf", [account]),
        contracts.pool.read("borrowRateBps", []),
      ];
      const [walletBal, supplied, suppliedValue, debt, health, power, collateralValue, mBal, rateBps] = await Promise.all(reads);
      setPos({ wallet: walletBal, supplied, suppliedValue, debt, health, power, collateralValue, borrowApr: Number(rateBps) / 100 });
      setMinrBal(mBal);
    } catch (e) { console.error(e); }
  }, [account, contracts, symbol]);

  useEffect(() => { loadPos(); }, [loadPos, refreshKey]);

  // "My positions" tab — aggregate real journal trades (spot + leverage) per symbol.
  // Spot: net shares (buys +, sells −) with weighted avg entry. Leverage: open tickets
  // each show live PnL vs current oracle price.
  const [journalPos, setJournalPos] = useState([]);
  useEffect(() => {
    let dead = false;
    if (cardView !== "positions" || !account) { setJournalPos([]); return; }
    (async () => {
      try {
        const res = await listJournal({ user: account, limit: 200 });
        const trades = (res.entities || []).map((e) => {
          const a = e.attributes || {};
          return {
            symbol: String(a.symbol || ""),
            side: String(a.side || ""),
            size: parseFloat(String(a.size ?? "0")) || 0,
            price: parseFloat(String(a.price ?? "0")) || 0,
            tradeType: String(a.trade_type || "spot"),
            leverage: Number(a.leverage ?? 1) || 1,
            createdMs: Number(a.created_ms?.value ?? a.created_ms ?? 0),
          };
        }).filter((t) => t.symbol && t.size > 0 && t.price > 0);

        // Spot netting per symbol
        const spotMap = new Map();
        // Leverage: each ticket kept as its own open position (journal-only, no on-chain close yet)
        const levPositions = [];
        for (const t of trades) {
          if (t.tradeType === "leverage") {
            const dir = t.side === "sell" ? -1 : 1;
            levPositions.push({
              kind: "leverage",
              sym: t.symbol,
              side: t.side,
              dir,
              size: t.size,
              entry: t.price,
              leverage: t.leverage,
              createdMs: t.createdMs,
            });
          } else {
            let s = spotMap.get(t.symbol);
            if (!s) { s = { sym: t.symbol, shares: 0, cost: 0, trades: 0 }; spotMap.set(t.symbol, s); }
            const signed = t.side === "sell" ? -t.size : t.size;
            // Cost basis: add on buy, reduce proportionally on sell
            if (signed > 0) {
              s.cost += t.size * t.price;
              s.shares += t.size;
            } else {
              const sold = Math.min(-signed, s.shares);
              const avg = s.shares > 0 ? s.cost / s.shares : t.price;
              s.cost -= sold * avg;
              s.shares -= sold;
            }
            s.trades += 1;
          }
        }

        const spotPositions = [...spotMap.values()]
          .filter((s) => s.shares > 1e-9)
          .map((s) => ({
            kind: "spot",
            sym: s.sym,
            side: "long",
            dir: 1,
            size: s.shares,
            entry: s.shares > 0 ? s.cost / s.shares : 0,
            leverage: 1,
            trades: s.trades,
          }));

        if (!dead) setJournalPos([...spotPositions, ...levPositions]);
      } catch (e) {
        console.error(e);
        if (!dead) setJournalPos([]);
      }
    })();
    return () => { dead = true; };
  }, [cardView, account, refreshKey]);

  // Equity = suppliedValue - debt (attributed when this asset is collateral)
  const equity = pos.suppliedValue > pos.debt ? pos.suppliedValue - pos.debt : 0n;
  const exposure = pos.suppliedValue > 0n && pos.suppliedValue > pos.debt
    ? Number(pos.suppliedValue) / Number(pos.suppliedValue - pos.debt)
    : null;
  const debtValue = pos.debt; // in mINR (1e18), assume 1:1 with INR
  const cushion = pos.health && pos.health > 10n ** 18n
    ? (Number(pos.health) / 1e18 - 1)
    : null;

  // ---------------- spot quoting ----------------

  const amountIn = (() => {
    try { return toToken(amount, 18); } catch { return 0n; }
  })();

  // Live quote from the venue: on-chain oracle price + fee, debounced.
  useEffect(() => {
    if (tradeType !== "spot" || !spotLive || !tokenAddr || !amountIn || amountIn <= 0n) {
      setQuote(null); setQuoteErr(null); setQuoting(false);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    const t = setTimeout(async () => {
      try {
        const [out, px] = side === "buy"
          ? await contracts.game.read("quoteBuy", [tokenAddr, amountIn])
          : await contracts.game.read("quoteSell", [tokenAddr, amountIn]);
        if (cancelled) return;
        setQuote({ amountIn, amountOut: out, price: px, at: Date.now() });
        setQuoteErr(null);
      } catch (e) {
        if (cancelled) return;
        setQuote(null);
        setQuoteErr(errMsg(e));
      } finally { if (!cancelled) setQuoting(false); }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [tradeType, spotLive, tokenAddr, side, amountIn, contracts, refreshKey]);

  // Quote-validity countdown for the review modal.
  useEffect(() => {
    if (!review) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [review]);

  const minOut = (out) => (out * (BPS - SLIPPAGE_BPS)) / BPS;
  const quoteExpired = review ? clock - reviewAt > QUOTE_TTL_MS : false;

  const usePct = (pct) => {
    const base = side === "buy" ? minrBal : pos?.wallet ?? 0n;
    if (base <= 0n) return;
    setAmount(formatUnits((base * BigInt(pct)) / 100n, 18));
    setReview(null);
  };

  const refreshQuote = useCallback(async () => {
    if (!spotLive || !tokenAddr || amountIn <= 0n) return null;
    const [out, px] = side === "buy"
      ? await contracts.game.read("quoteBuy", [tokenAddr, amountIn])
      : await contracts.game.read("quoteSell", [tokenAddr, amountIn]);
    const fresh = { amountIn, amountOut: out, price: px, at: Date.now() };
    setQuote(fresh);
    return fresh;
  }, [spotLive, tokenAddr, amountIn, side, contracts]);

  const requestReview = async () => {
    if (!account) { wallet.connect(); return; }
    if (!spotLive) {
      onToast?.({ kind: "err", msg: "spot venue is deploying — hold on" });
      return;
    }
    setBusy(true);
    try {
      const fresh = await refreshQuote();
      if (!fresh || fresh.amountOut <= 0n) throw new Error("quote unavailable — try a different amount");
      if (side === "buy" && fresh.amountIn > minrBal) throw new Error("not enough mINR — claim from the faucet in Lend");
      if (side === "sell" && fresh.amountIn > (pos?.wallet ?? 0n)) throw new Error(`not enough ${ticker} in your wallet`);
      setReview(fresh);
      setReviewAt(Date.now());
    } catch (e) {
      onToast?.({ kind: "err", msg: errMsg(e) });
    } finally { setBusy(false); }
  };

  // Approve (if needed) → trade, one wallet confirmation each, then journal.
  const executeReviewed = async () => {
    if (!review || busy) return;
    setBusy(true);
    const q = review;
    try {
      const gameAddr = CONTRACTS.game;
      const spender = gameAddr;
      let hash;

      if (side === "buy") {
        const allowance = await contracts.minr.read("allowance", [account, spender]);
        if (allowance < q.amountIn) {
          setStage(`Approve mINR in wallet`);
          await contracts.minr.write("approve", [spender, q.amountIn]);
          setStage(`Confirming approval`);
        }
        setStage(`Buy ${ticker} in wallet`);
        hash = await contracts.game.write("buyStock", [tokenAddr, q.amountIn, minOut(q.amountOut)]);
      } else {
        const allowance = await contracts.token(tokenAddr).read("allowance", [account, spender]);
        if (allowance < q.amountIn) {
          setStage(`Approve ${ticker} in wallet`);
          await contracts.token(tokenAddr).write("approve", [spender, q.amountIn]);
          setStage(`Confirming approval`);
        }
        setStage(`Sell ${ticker} in wallet`);
        hash = await contracts.game.write("sellStock", [tokenAddr, q.amountIn, minOut(q.amountOut)]);
      }
      setStage("Writing ticket to Arkiv…");

      // Journal the real fill: shares at the effective price you actually paid
      // (venue fee included — buy costs slightly more per share, sell pays out slightly less).
      const shares = side === "buy" ? q.amountOut : q.amountIn;
      const paid = side === "buy" ? q.amountIn : q.amountOut;
      const avgPrice = Number(paid) / Number(shares);
      await createJournal({
        user: account, symbol, side,
        size: formatUnits(shares, 18),
        price: avgPrice.toFixed(8).replace(/0+$/, "").replace(/\.$/, ""),
        pnlBps: 0, session: session.current,
        note: note ? `${note} · onchain ${hash?.slice(0, 10)}` : `onchain ${hash?.slice(0, 10)}`,
        tradeType: "spot",
      });

      onToast?.({
        kind: "ok",
        msg: side === "buy"
          ? `bought ${fmtToken(q.amountOut, 18, 4)} ${ticker} ✓ · ticket on Arkiv ✓`
          : `sold ${fmtToken(q.amountIn, 18, 4)} ${ticker} ✓ · ticket on Arkiv ✓`,
      });
      setReview(null);
      setAmount(""); setNote("");
      await loadPos();
    } catch (e) {
      onToast?.({ kind: "err", msg: errMsg(e) });
      setReview(null);
    } finally {
      setBusy(false); setStage(null);
    }
  };

  // Leverage: sign the ticket in the external wallet (MetaMask), then journal it.
  // Borrowing itself lives in EQORA Lend.
  const recordLeverage = async () => {
    if (!account) { wallet.connect(); return; }
    const shares = parseFloat(amount);
    if (!shares || shares <= 0) {
      onToast?.({ kind: "err", msg: "enter a share quantity first (e.g. 1)" });
      return;
    }
    setBusy(true);
    const p = price || currentPrice;
    try {
      const risk = ` SL ${slPct}% TP +${tpPct}%`;
      const message = [
        "EQORA leverage ticket",
        "chain: Polygon Amoy (80002)",
        `account: ${account}`,
        `market: ${symbol}`,
        `side: ${side.toUpperCase()} ${leverage}x`,
        `size: ${amount} ${ticker} @ ${curSym}${p}`,
        `notional: ${curSym}${ticketAmount.toFixed(2)}`,
        `${risk.trim()}`,
        `time: ${new Date().toISOString()}`,
      ].join("\n");

      setStage("Sign ticket in wallet");
      const signature = await wallet.signMessage(message);
      setStage("Writing ticket to Arkiv…");

      await createJournal({
        user: account, symbol, side,
        size: amount || "0", price: String(p),
        pnlBps: 0, session: session.current, note: note ? `${note}${risk}` : risk.trim(),
        tradeType: "leverage", leverage,
        signature, signedMessage: message,
      });
      onToast?.({ kind: "ok", msg: `${leverage}x ${side.toUpperCase()} ticket signed ✓ · written to Arkiv ✓` });
      setAmount(""); setNote("");
    } catch (e) {
      onToast?.({ kind: "err", msg: errMsg(e) });
    } finally { setBusy(false); setStage(null); }
  };

  const ticketAmount = (parseFloat(amount) || 0) * (parseFloat(price) || currentPrice);
  const borrowedAmount = tradeType === "leverage" ? ticketAmount * (leverage - 1) / leverage : 0;

  const reviewSecondsLeft = review
    ? Math.max(0, Math.ceil((reviewAt + QUOTE_TTL_MS - clock) / 1000))
    : 0;

  // Spot sell: pay shares, receive mINR. Spot buy: pay mINR, receive shares.
  const payUnit = side === "buy" ? "mINR" : ticker;
  const recvUnit = side === "buy" ? ticker : "mINR";
  const payBalance = side === "buy" ? minrBal : pos?.wallet ?? 0n;

  return (
    <div className="trade-layout">
      {/* LEFT: chart + position panel */}
      <div className="trade-left">
        <div className="chart-card">
          <div className="chart-tabs">
            <button className={`chart-tab${cardView === "chart" ? " active" : ""}`} onClick={() => setCardView("chart")}>📊 {ticker} chart</button>
            <button className={`chart-tab${cardView === "positions" ? " active" : ""}`} onClick={() => setCardView("positions")}>My positions</button>
            <div className="asset-quickbar">
              {SYMBOLS.map((s) => (
                <button key={s} className={symbol === s ? "active" : ""} onClick={() => { setSymbol(s); setCardView("chart"); }}>
                  <AssetIcon sym={s} size={18} />
                  {s.replace("IND-", "")}
                </button>
              ))}
            </div>
          </div>

          {cardView === "positions" ? (
            <div className="chart-positions">
              {journalPos.length === 0 ? (
                <div className="empty">
                  {account ? "No open positions yet — place a spot or leverage trade to see it here." : "Connect your wallet to see your positions."}
                </div>
              ) : (
                <div className="pos-table">
                  <div className="pos-head">
                    <span>Market</span><span>Side</span><span>Size</span><span>Entry</span><span>Mark</span><span>Unrealized P&amp;L</span><span></span>
                  </div>
                  {journalPos.map((r, i) => {
                    const mark = prices.find((p) => p.symbol === r.sym)?.price || 0;
                    const notional = r.size * mark;
                    const entryNotional = r.size * r.entry;
                    // dir=1 long (buy), dir=-1 short (sell). PnL in ₹.
                    const pnlInr = r.dir * (notional - entryNotional);
                    const pnlPct = entryNotional > 0 ? (pnlInr / entryNotional) * 100 * r.leverage : 0;
                    const pnlClass = pnlInr > 0 ? "pos" : pnlInr < 0 ? "neg" : "";
                    return (
                      <div className="pos-row" key={`${r.kind}-${r.sym}-${i}`}>
                        <span className="pos-sym">
                          <AssetIcon sym={r.sym} size={20} />
                          {r.sym.replace("IND-", "")}
                          {r.kind === "leverage" && <span className="pill" style={{ color: "#fcd34d", borderColor: "rgba(245,158,11,.3)" }}>{r.leverage}x</span>}
                          {r.kind === "spot" && <span className="pill" style={{ color: "var(--muted)", borderColor: "var(--line)" }}>spot</span>}
                        </span>
                        <span>
                          <span className={`side ${r.side === "sell" ? "sell" : "buy"}`} style={{
                            padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 700, textTransform: "uppercase",
                            background: r.dir > 0 ? "rgba(52,211,153,.15)" : "rgba(255,95,158,.15)",
                            color: r.dir > 0 ? "#6ee7b7" : "#fbcfe8",
                          }}>
                            {r.kind === "leverage" ? r.side : "long"}
                          </span>
                        </span>
                        <span className="mono">{r.size.toFixed(4)}</span>
                        <span className="mono">{curSym}{fmtInr(r.entry)}</span>
                        <span className="mono">{curSym}{fmtInr(mark)}</span>
                        <span className={`mono ${pnlClass}`} style={{ fontWeight: 700 }}>
                          {pnlInr >= 0 ? "+" : ""}{curSym}{fmtInr(pnlInr)}<br />
                          <span style={{ fontSize: 11, fontWeight: 500 }}>{pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%</span>
                        </span>
                        <button className="mini" onClick={() => { setSymbol(r.sym); setCardView("chart"); }}>Trade →</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <>
          <div className="chart-head">
            <div className="chart-symbol">
              <AssetIcon sym={symbol} size={40} />
              <div>
                <div className="cs-name">{ticker} {LENDABLE.includes(symbol) && <span className="pill" style={{ marginLeft: 6, color: "#fcd34d", borderColor: "rgba(245,158,11,.3)" }}>Collateral</span>}</div>
                <div className="cs-tick">{symbol} · NSE (simulated)</div>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="chart-price"><span style={{ color: "var(--up)" }}>{curSym}</span>{fmtInr(currentPrice)}</div>
              <div className={`chart-change ${change >= 0 ? "up" : "down"}`}>
                {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(2)}% · today
              </div>
            </div>
            <div className="chart-ranges">
              {RANGES.map((r) => (
                <button key={r.key} className={rangeKey === r.key ? "active" : ""} onClick={() => setRangeKey(r.key)}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className="chart-body" ref={chartEl} />
          <div style={{ padding: "8px 18px", borderTop: "1px solid var(--line)", fontSize: 11, color: "var(--faint)", display: "flex", justifyContent: "space-between" }}>
            <span>EQORA oracle · relayed NSE reference prices</span>
          </div>
            </>
          )}
        </div>

        {/* Position panel (below chart) */}
        <div className="position-panel">
          <div className="pp-head">
            <div className="pp-title">Your {ticker} position</div>
            {exposure && <div className="pp-leverage">{exposure.toFixed(2)}x long</div>}
          </div>
          <div className="pp-grid">
            <div className="pp-stat">
              <div className="k">In wallet</div>
              <div className="v">{curSym}{fmtInr(Number(pos.wallet) / 1e18 * currentPrice)}</div>
              <div className="sub">{fmtToken(pos.wallet, 18, 4)} {ticker}</div>
            </div>
            <div className="pp-stat">
              <div className="k">Supplied</div>
              <div className="v">{curSym}{fmtInr(Number(pos.suppliedValue) / 1e18)}</div>
              <div className="sub">{fmtToken(pos.supplied, 18, 4)} {ticker}</div>
            </div>
            {pos.debt > 0n && (
              <div className="pp-stat">
                <div className="k">Your equity</div>
                <div className="v">{curSym}{fmtInr(Number(equity) / 1e18)}</div>
                <div className="sub">Supplied value − debt</div>
              </div>
            )}
            {pos.debt > 0n && (
              <div className="pp-stat">
                <div className="k">Borrowed</div>
                <div className="v">{fmtToken(pos.debt, 18, 2)}</div>
                <div className="sub">mINR</div>
              </div>
            )}
            {pos.debt === 0n && (
              <div className="pp-stat">
                <div className="k">Borrowing power</div>
                <div className="v">{curSym}{fmtInr(Number(pos.power) / 1e18)}</div>
                <div className="sub">Available to borrow</div>
              </div>
            )}
          </div>
          <div className="pp-status">
            {pos.debt > 0n && (
              <span>Account health <strong className={healthClass(pos.health)}>{fmtHealth(pos.health)}</strong></span>
            )}
            {pos.debt > 0n && cushion != null && (
              <span>Liquidation <strong className="bad">−{(cushion * 100).toFixed(1)}%</strong></span>
            )}
            <span>Borrow APR <strong>{pos.borrowApr.toFixed(2)}%</strong></span>
          </div>
          <div className="pp-actions">
            <button className="green" onClick={() => navigate(`/lend/${ticker}`)}>Supply</button>
            <button onClick={() => navigate(`/lend/${ticker}`)}>Withdraw</button>
            <button onClick={() => navigate(`/lend/${ticker}`)}>Borrow</button>
            <button onClick={() => navigate(`/lend/${ticker}`)}>Repay</button>
            {(pos.debt > 0n || pos.wallet > 0n) && (
              <button
                onClick={() => {
                  if (pos.debt > 0n) {
                    navigate(`/lend/${ticker}`);
                  } else {
                    setTradeType("spot");
                    setSide("sell");
                    setAmount(String(Number(formatUnits(pos.wallet, 18))));
                  }
                }}
              >
                Close position
              </button>
            )}
          </div>
        </div>
      </div>

      {/* RIGHT: trade ticket with Spot | Leverage toggle */}
      <div className="trade-ticket">
        <div className="tt-type-toggle">
          <button className={tradeType === "spot" ? "active" : ""} onClick={() => { setTradeType("spot"); setReview(null); }}>
            Spot
          </button>
          <button className={tradeType === "leverage" ? "active" : ""} onClick={() => { setTradeType("leverage"); setReview(null); }}>
            Leverage <span className="tag">EQORA Lend</span>
          </button>
        </div>

        <div className="tt-side-toggle">
          <button className={`buy ${side === "buy" ? "active" : ""}`} onClick={() => { setSide("buy"); setReview(null); }}>
            Buy {ticker}
          </button>
          <button className={`sell ${side === "sell" ? "active" : ""}`} onClick={() => { setSide("sell"); setReview(null); }}>
            Sell {ticker}
          </button>
        </div>

        <div className="tt-body">
          {tradeType === "spot" ? (
            <>
              {/* You pay */}
              <div className="tt-label">
                <span>You pay</span>
                <span>
                  Balance {fmtToken(payBalance, 18, 4)}{" "}
                  <button
                    className="tt-max"
                    disabled={payBalance <= 0n}
                    onClick={() => usePct(100)}
                  >max</button>
                </span>
              </div>
              <div className="ap-amount-box">
                <input
                  type="number" min="0" step="any" placeholder="0"
                  value={amount}
                  onChange={(e) => { setAmount(e.target.value); setReview(null); }}
                />
                <div className="ap-amount-meta">
                  <span>{payUnit}</span>
                  <span>≈ {curSym}{fmtInr(side === "buy" ? Number(amountIn) / 1e18 : (Number(amountIn) / 1e18) * currentPrice)}</span>
                </div>
              </div>
              <div className="ap-pct-row">
                {[25, 50, 75, 100].map((pct) => (
                  <button key={pct} onClick={() => usePct(pct)}>{pct === 100 ? "Max" : `${pct}%`}</button>
                ))}
              </div>

              {/* Estimated receive */}
              <div className="tt-label">
                <span>Estimated receive <span style={{ opacity: 0.7 }}>· after 0.30% fee</span></span>
                {quoting && <span className="tt-quat">getting quote…</span>}
              </div>
              <div className="ap-amount-box recv">
                <div className="tt-recv">
                  {quote
                    ? fmtToken(quote.amountOut, 18, 6)
                    : amountIn > 0n && quoteErr
                      ? <span className="tt-err">{quoteErr}</span>
                      : "—"}
                </div>
                <div className="ap-amount-meta">
                  <span>{recvUnit}</span>
                  <span>
                    {quote
                      ? `≈ ${curSym}${fmtInr(side === "buy"
                          ? (Number(quote.amountOut) / 1e18) * currentPrice
                          : Number(quote.amountOut) / 1e18)}`
                      : ""}
                  </span>
                </div>
              </div>

              <input
                type="text" placeholder="note (stored in payload)"
                value={note} onChange={(e) => setNote(e.target.value)}
                style={{ width: "100%", marginBottom: 12 }}
              />

              {!account ? (
                <button className="ap-cta borrow" onClick={wallet.connect}>Connect Wallet</button>
              ) : (
                <button
                  className={`ap-cta ${side === "buy" ? "supply" : "repay"}`}
                  disabled={!!busy || !amountIn || quoting || !spotLive}
                  onClick={requestReview}
                  style={side === "sell" ? { background: "rgba(239,68,68,.15)", border: "1px solid rgba(239,68,68,.4)", color: "#ffb3b3" } : {}}
                >
                  {busy ? "Fetching quote…" : !spotLive
                    ? "Spot venue deploying…"
                    : `Review ${side.toUpperCase()} ${ticker}`}
                </button>
              )}

              <div className="tt-hint">
                Spot fills settle on Polygon Amoy from the EQORA venue — your wallet signs every trade.
                Each fill is then written as an immutable <strong>trade_journal</strong> entity on Arkiv with
                your address as <span className="mono">createdBy</span>. The journal that can't be faked.
              </div>

              <div className="tt-section">
                <div className="ap-info-row" style={{ borderTop: "none", paddingTop: 0 }}>
                  <span className="k">Oracle price</span>
                  <span className="v">{curSym}{fmtInr(currentPrice)}</span>
                </div>
                <div className="ap-info-row">
                  <span className="k">Venue fee</span>
                  <span className="v">0.30% · included in quote</span>
                </div>
                <div className="ap-info-row">
                  <span className="k">Slippage guard</span>
                  <span className="v">0.50% · minimum output</span>
                </div>
                <div className="ap-info-row">
                  <span className="k">Settlement</span>
                  <span className="v" style={{ color: spotLive ? "var(--up)" : "var(--faint)" }}>
                    {spotLive ? "on-chain · Amoy" : "deploying"}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="tt-label">
                <span>You pay</span>
                <span>Balance {fmtToken(pos?.wallet ?? 0n, 18, 4)}</span>
              </div>
              <div className="ap-amount-box">
                <input
                  type="number" min="0" step="any" placeholder="0"
                  value={amount} onChange={(e) => setAmount(e.target.value)}
                />
                <div className="ap-amount-meta">
                  <span>{ticker} (shares)</span>
                  <span>≈ {curSym}{fmtInr(ticketAmount)}</span>
                </div>
              </div>
              <div className="ap-pct-row">
                {[1, 2, 5, 10, 15].map((n) => (
                  <button key={n} onClick={() => setAmount(String(n))}>{n}.00</button>
                ))}
              </div>

              <div className="tt-label" style={{ marginTop: 10 }}>
                <span>Leverage</span>
                <span className={`risk-tag ${leverage <= 2 ? "low" : leverage <= 3 ? "mid" : "high"}`}>
                  {leverage <= 2 ? "Low Risk" : leverage <= 3 ? "Medium Risk" : "High Risk"}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 32, fontWeight: 800, fontFamily: "var(--mono)" }}>{leverage}x</span>
              </div>
              <div className="tt-slider-wrap">
                <input
                  type="range" className="tt-slider"
                  min="1" max="5" step="0.5" value={leverage}
                  onChange={(e) => setLeverage(Number(e.target.value))}
                />
                <div className="tt-slider-ticks"><span>1x</span><span>2x</span><span>3x</span><span>4x</span><span>5x</span></div>
              </div>
              <div className="ap-info-row" style={{ borderTop: "none", paddingTop: 4 }}>
                <span className="k">You borrow</span>
                <span className="v" style={{ color: "var(--accent)" }}>{curSym}{fmtInr(borrowedAmount)} mINR</span>
              </div>
              <div className="ap-info-row" style={{ paddingTop: 4 }}>
                <span className="k">Position size</span>
                <span className="v">{curSym}{fmtInr(ticketAmount * leverage)}</span>
              </div>

              <div className="tt-section">
                <div className="tt-label">
                  <span>Stop Loss</span>
                  <span className="mono" style={{ color: "var(--pink)" }}>{slPct}%</span>
                </div>
                <div className="ap-pct-row">
                  {[0, -10, -25, -50, -75].map((v) => (
                    <button key={v} className={slPct === v ? "active" : ""} onClick={() => setSlPct(v)}>
                      {v}%
                    </button>
                  ))}
                </div>
              </div>
              <div className="tt-section">
                <div className="tt-label">
                  <span>Take Profit</span>
                  <span className="mono" style={{ color: "var(--up)" }}>+{tpPct}%</span>
                </div>
                <div className="ap-pct-row">
                  {[25, 50, 100, 300, 900].map((v) => (
                    <button key={v} className={tpPct === v ? "active" : ""} onClick={() => setTpPct(v)}>
                      {v}%
                    </button>
                  ))}
                </div>
              </div>

              <div className="tt-label" style={{ marginTop: 10 }}>
                <span>Execution price</span>
                <span>live {curSym}{fmtInr(currentPrice)}</span>
              </div>
              <div className="ap-amount-box">
                <input
                  type="number" min="0" step="any" placeholder={String(currentPrice || "0.0")}
                  value={price} onChange={(e) => setPrice(e.target.value)}
                />
                <div className="ap-amount-meta">
                  <span>{curSym}</span>
                  <span>oracle price</span>
                </div>
              </div>

              <input
                type="text" placeholder="note (stored in payload)"
                value={note} onChange={(e) => setNote(e.target.value)}
                style={{ width: "100%", marginBottom: 12 }}
              />

              {!account ? (
                <button className="ap-cta borrow" onClick={wallet.connect}>Connect Wallet</button>
              ) : (
                <button
                  className="ap-cta supply"
                  disabled={!!busy || !amount}
                  onClick={recordLeverage}
                >
                  {busy ? (stage || "Sign in wallet…") : `${leverage}x ${side.toUpperCase()} ${ticker} → Arkiv`}
                </button>
              )}

              <div className="tt-hint">
                Every ticket is <strong>signed in your wallet</strong>, then written as an immutable{" "}
                <strong>trade_journal</strong> entity on Arkiv (Tiramisu) with
                your address as <span className="mono">createdBy</span>. Entries cannot be edited or deleted — the
                journal that can't be faked. Borrow the mINR side in <strong>EQORA Lend</strong>.
              </div>
            </>
          )}

          <div className="ap-info-row" style={{ marginTop: 10 }}>
            <span className="k">Session</span>
            <span className="v mono" style={{ fontSize: 11 }}>{session.current}</span>
          </div>
          <div className="ap-info-row">
            <span className="k">Market</span>
            <span className="v">{symbol}</span>
          </div>
        </div>
      </div>

      {/* Review modal — quote → confirm flow */}
      {review && (
        <div className="modal-overlay" onClick={() => !busy && setReview(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Review your trade</h3>
              <button className="modal-x" disabled={busy} onClick={() => setReview(null)} aria-label="Close">✕</button>
            </div>

            <div className="modal-pair">
              <div>
                <p className="modal-k">You pay</p>
                <p className="modal-v">{fmtToken(review.amountIn, 18, 6)} {payUnit}</p>
              </div>
              <div>
                <p className="modal-k">Estimated receive</p>
                <p className="modal-v up">{fmtToken(review.amountOut, 18, 6)} {recvUnit}</p>
              </div>
            </div>

            <div className="modal-rows">
              <div className="modal-row">
                <span>Average price <span className="modal-sub">· fee included</span></span>
                <span>{curSym}{fmtInr(Number(side === "buy" ? review.amountIn : review.amountOut) / Number(side === "buy" ? review.amountOut : review.amountIn))} / {ticker}</span>
              </div>
              <div className="modal-row">
                <span>Minimum receive <span className="modal-sub">· 0.50% slippage</span></span>
                <span>{fmtToken(minOut(review.amountOut), 18, 6)} {recvUnit}</span>
              </div>
              <div className="modal-row">
                <span>Venue fee</span>
                <span>0.30% · included</span>
              </div>
              <div className="modal-row">
                <span>Recipient</span>
                <span className="mono">{account?.slice(0, 6)}…{account?.slice(-4)}</span>
              </div>
              <div className="modal-row">
                <span>Network</span>
                <span>Polygon Amoy · gas is additional</span>
              </div>
            </div>

            <div className="modal-foot">
              <span>Quotes refresh every {QUOTE_TTL_MS / 1000}s</span>
              <span className={reviewSecondsLeft <= 5 ? "modal-expire" : "mono"}>
                {quoteExpired ? "Quote expired" : `expires in ${reviewSecondsLeft}s`}
              </span>
            </div>

            <button
              className={`ap-cta ${side === "buy" ? "supply" : "repay"}`}
              disabled={busy}
              onClick={quoteExpired ? requestReview : executeReviewed}
              style={side === "sell" ? { background: "rgba(239,68,68,.15)", border: "1px solid rgba(239,68,68,.4)", color: "#ffb3b3" } : {}}
            >
              {busy ? (stage || "Working…") : quoteExpired ? "Refresh quote" : "Confirm trade"}
            </button>

            <div className="tt-hint" style={{ marginTop: 10 }}>
              {side === "buy"
                ? `Confirming asks your wallet to approve mINR spending once, then swap ${fmtToken(review.amountIn, 18, 4)} mINR for ${ticker}.`
                : `Confirming asks your wallet to approve ${ticker} spending once, then swap ${fmtToken(review.amountIn, 18, 4)} ${ticker} for mINR.`}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
