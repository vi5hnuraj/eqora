import { formatUnits, parseUnits } from "viem";

// ── currency display (INR default, USD toggle) ──────────────────────────
// fmtInr converts the *display* only. Settlement/accounting stays in INR/mINR.
// A module-level store so every fmtInr call site updates without a React hook.
const CUR_KEY = "eqora-currency";
let _currency = (typeof localStorage !== "undefined" && localStorage.getItem(CUR_KEY)) || "INR";
let _usdInr = 83.5; // fallback until live rate loads
const _subs = new Set();

export function getCurrency() { return _currency; }
export function getUsdInr() { return _usdInr; }
export function setUsdInr(rate) {
  if (Number.isFinite(rate) && rate > 0) _usdInr = rate;
}
export function setCurrency(cur) {
  _currency = cur === "USD" ? "USD" : "INR";
  try { localStorage.setItem(CUR_KEY, _currency); } catch { /* private mode */ }
  _subs.forEach((fn) => fn(_currency));
}
export function toggleCurrency() {
  setCurrency(_currency === "USD" ? "INR" : "USD");
}
export function subscribeCurrency(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}
// symbol for the current display currency
export const curSymbol = () => (_currency === "USD" ? "$" : "₹");
// convert an INR-denominated number to the display currency
export const curValue = (inr) => (_currency === "USD" ? inr / _usdInr : inr);

export const fmtInr = (value, decimals = 2) => {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const n = curValue(Number(value));
  const locale = _currency === "USD" ? "en-US" : "en-IN";
  return n.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

// currency symbol for JSX (use alongside fmtInr)
export const fmtCur = () => curSymbol();

export const fmtToken = (wei, decimals = 18, dp = 4) => {
  if (wei == null) return "—";
  const n = Number(formatUnits(wei, decimals));
  return n.toLocaleString("en-IN", { maximumFractionDigits: dp });
};

export const toToken = (value, decimals = 18) => parseUnits(String(value || "0"), decimals);

// Health factor is 1e18-scaled. < 1e18 = liquidatable, max = no debt.
export const fmtHealth = (health) => {
  if (health == null) return "—";
  const h = Number(formatUnits(health, 18));
  if (h > 1e15) return "∞";
  return h.toFixed(2);
};

export const healthClass = (health) => {
  if (health == null) return "neutral";
  const h = Number(formatUnits(health, 18));
  if (h > 1e15) return "good";
  if (h < 1) return "bad";
  if (h < 1.1) return "warn";
  return "good";
};

export const short = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—");

export const timeAgo = (ms) => {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
