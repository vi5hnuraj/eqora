import { useCallback, useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Nav from "./Nav.jsx";
import TickerBar from "./TickerBar.jsx";
import Lend from "./Lend.jsx";
import Trade from "./Trade.jsx";
import Portfolio from "./Portfolio.jsx";
import Activity from "./Activity.jsx";
import Explorer from "./Explorer.jsx";
import { useWallet } from "./wallet.js";
import { CurrencyProvider } from "./currency.jsx";
import { API, SYMBOLS } from "./config.js";

const TICKERS = {
  "IND-RELIANCE": "RELIANCE.NS", "IND-TCS": "TCS.NS", "IND-HDFCBANK": "HDFCBANK.NS",
  "IND-ICICIBANK": "ICICIBANK.NS", "IND-INFY": "INFY.NS", "IND-HINDUNILVR": "HINDUNILVR.NS",
  "IND-ITC": "ITC.NS", "IND-SBIN": "SBIN.NS", "IND-BHARTIARTL": "BHARTIARTL.NS",
  "IND-LT": "LT.NS", "IND-NIFTY": "^NSEI",
};

export default function App() {
  const wallet = useWallet();
  const [prices, setPrices] = useState(SYMBOLS.map((s) => ({ symbol: s, ticker: TICKERS[s], price: null })));
  const [marketOpen, setMarketOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const flash = useCallback((t) => {
    setToast(t);
    setTimeout(() => setToast(null), 4200);
  }, []);

  const loadMarket = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/prices`);
      const body = await res.json();
      if (Array.isArray(body.prices)) {
        setPrices(body.prices.map((p) => ({
          symbol: p.symbol,
          ticker: TICKERS[p.symbol] || p.ticker,
          price: p.price ?? null,
          updatedAt: p.updatedAt ? new Date(p.updatedAt).toLocaleTimeString("en-IN") : null,
        })));
      }
    } catch { /* keep last prices */ }
    try { setMarketOpen(await wallet.contracts.window.read("canBorrow", [])); }
    catch { /* ignore */ }
  }, [wallet.contracts]);

  useEffect(() => {
    loadMarket();
    const id = setInterval(loadMarket, 30000);
    return () => clearInterval(id);
  }, [loadMarket]);

  return (
    <CurrencyProvider>
    <div className="app">
      <Nav wallet={wallet} marketOpen={marketOpen} />

      <Routes>
        <Route path="/" element={<Navigate to="/trade" replace />} />
        <Route path="/trade" element={
          <Trade wallet={wallet} prices={prices} refreshKey={refreshKey} onToast={flash} />
        } />
        <Route path="/lend" element={
          <Lend wallet={wallet} prices={prices} marketOpen={marketOpen} refreshKey={refreshKey} onToast={flash} />
        } />
        <Route path="/lend/:sym" element={
          <Lend wallet={wallet} prices={prices} marketOpen={marketOpen} refreshKey={refreshKey} onToast={flash} />
        } />
        <Route path="/portfolio" element={
          <Portfolio wallet={wallet} refreshKey={refreshKey} onToast={flash} />
        } />
        <Route path="/activity" element={
          <Activity wallet={wallet} refreshKey={refreshKey} onToast={flash} />
        } />
        <Route path="/explorer" element={
          <Explorer wallet={wallet} onToast={flash} />
        } />
        <Route path="/more" element={<Navigate to="/activity" replace />} />
        <Route path="*" element={<Navigate to="/trade" replace />} />
      </Routes>

      <TickerBar prices={prices} />

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
    </CurrencyProvider>
  );
}
