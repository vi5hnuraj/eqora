import { useState } from "react";

const ASSET_COLORS = {
  "IND-RELIANCE": "linear-gradient(135deg,#5b8def,#3b6fd4)",
  "IND-TCS": "linear-gradient(135deg,#ff9933,#e07a1a)",
  "IND-NIFTY": "linear-gradient(135deg,#22c55e,#15803d)",
  "IND-HDFCBANK": "linear-gradient(135deg,#ef4444,#b91c1c)",
  "IND-ICICIBANK": "linear-gradient(135deg,#f59e0b,#d97706)",
  "IND-INFY": "linear-gradient(135deg,#06b6d4,#0e7490)",
  "IND-HINDUNILVR": "linear-gradient(135deg,#3b82f6,#1d4ed8)",
  "IND-ITC": "linear-gradient(135deg,#84cc16,#4d7c0f)",
  "IND-SBIN": "linear-gradient(135deg,#14b8a6,#0f766e)",
  "IND-BHARTIARTL": "linear-gradient(135deg,#f43f5e,#be123c)",
  "IND-LT": "linear-gradient(135deg,#8b5cf6,#6d28d9)",
  mINR: "linear-gradient(135deg,#a78bfa,#7c3aed)",
};

export default function AssetIcon({ sym, size = 38 }) {
  const [failed, setFailed] = useState(false);
  const initials = sym.replace("IND-", "").slice(0, 2);

  // mINR is our own mock token (no company logo) — keep the branded letter tile.
  if (sym === "mINR" || failed) {
    return (
      <div
        className="mr-icon"
        style={{
          background: ASSET_COLORS[sym] || ASSET_COLORS.mINR,
          width: size,
          height: size,
          fontSize: size * 0.34,
        }}
      >
        {initials}
      </div>
    );
  }

  return (
    <div className="mr-icon logo" style={{ width: size, height: size }}>
      <img
        src={`/logos/${sym}.svg`}
        alt=""
        onError={() => setFailed(true)}
        draggable={false}
      />
    </div>
  );
}
