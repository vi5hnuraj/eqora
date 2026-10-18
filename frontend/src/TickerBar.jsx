import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fmtInr } from "./format.js";
import { useCurrency } from "./currency.jsx";
import { getCandles } from "./api.js";
import AssetIcon from "./AssetIcon.jsx";

function TickerBar({ prices }) {
  const navigate = useNavigate();
  const { symbol: curSym } = useCurrency();
  const [change, setChange] = useState({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const next = {};
      await Promise.all(prices.map(async (p) => {
        try {
          const data = await getCandles(p.symbol, "1d");
          const closes = (data.candles || []).slice(-2).map((c) => c.close);
          if (closes.length === 2) {
            next[p.symbol] = ((closes[1] - closes[0]) / closes[0]) * 100;
          }
        } catch { /* keep placeholder */ }
      }));
      if (!cancelled) setChange(next);
    };
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [prices.map((p) => p.symbol).join(",")]);

  const items = (
    <>
      {prices.map((p) => {
        const ch = change[p.symbol];
        const up = (ch ?? 0) >= 0;
        return (
          <button key={p.symbol} className="tbar-item" onClick={() => navigate("/trade")}>
            <AssetIcon sym={p.symbol} size={22} />
            <span className="tbar-sym">{p.symbol.replace("IND-", "")}</span>
            <span className={`tbar-px ${up ? "up" : "down"}`}>
              {curSym}{p.price != null ? fmtInr(p.price) : "—"}
            </span>
            {ch != null && (
              <span className={`tbar-chg ${up ? "up" : "down"}`}>
                {up ? "▲" : "▼"} {Math.abs(ch).toFixed(2)}%
              </span>
            )}
          </button>
        );
      })}
    </>
  );

  return (
    <div className="tbar">
      <div className="tbar-track">
        <div className="tbar-group">{items}</div>
        <div className="tbar-group" aria-hidden="true">{items}</div>
      </div>
    </div>
  );
}

export default TickerBar;
