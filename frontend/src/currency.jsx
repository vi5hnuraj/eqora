import { createContext, useContext, useEffect, useState, useCallback } from "react";
import {
  getCurrency, setCurrency, toggleCurrency, subscribeCurrency,
  getUsdInr, setUsdInr, curSymbol, curValue,
} from "./format.js";
import { getFx } from "./api.js";

const CurrencyContext = createContext(null);

export function CurrencyProvider({ children }) {
  const [currency, setCur] = useState(getCurrency());
  const [usdInr, setRate] = useState(getUsdInr());

  // keep React state in sync with the module store (for other subscribers)
  useEffect(() => subscribeCurrency(setCur), []);

  // pull the live USD/INR rate once on mount; cache the last good value
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await getFx();
        if (!dead && Number.isFinite(res?.rate) && res.rate > 0) {
          setUsdInr(res.rate);
          setRate(res.rate);
          try { localStorage.setItem("eqora-usdinr", String(res.rate)); } catch { /* ignore */ }
        }
      } catch { /* keep fallback / cached */ }
    })();
    return () => { dead = true; };
  }, []);

  const toggle = useCallback(() => toggleCurrency(), []);

  return (
    <CurrencyContext.Provider value={{ currency, usdInr, setCurrency, toggle, symbol: curSymbol(), curValue }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error("useCurrency must be used within CurrencyProvider");
  return ctx;
}

// small hook for a component that just needs the symbol to re-render on toggle
export function useCurSymbol() {
  return useCurrency().symbol;
}
