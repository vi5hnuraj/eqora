import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { LENDABLE, CONTRACTS } from "./config.js";
import { createLendEvent } from "./api.js";
import { fmtInr, fmtToken, fmtHealth, healthClass, toToken } from "./format.js";
import { useCurrency } from "./currency.jsx";
import AssetIcon from "./AssetIcon.jsx";

// URL uses short names: /lend/RELIANCE, /lend/mINR
// Internal symbols: IND-RELIANCE, mINR
const urlToSym = (u) => {
  if (!u) return null;
  if (u.toUpperCase() === "MINR") return "mINR";
  return `IND-${u.toUpperCase()}`;
};
const symToUrl = (s) => (s === "mINR" ? "mINR" : s.replace("IND-", ""));

export default function Lend({ wallet, prices, marketOpen, refreshKey, onToast }) {
  const { currency, symbol: curSym } = useCurrency();
  const { account, contracts, read, write } = wallet;
  const { sym: urlSym } = useParams();
  const navigate = useNavigate();
  const detailSym = urlToSym(urlSym);
  const [market, setMarket] = useState({ assets: [], totals: { market: 0, available: 0, borrowed: 0 } });
  const [accountData, setAccountData] = useState(null);
  const [balances, setBalances] = useState({});
  const [collateralOf, setCollateralOf] = useState({});
  const [minrBal, setMinrBal] = useState(0n);
  const [selected, setSelected] = useState(LENDABLE[0]);
  const [detailTab, setDetailTab] = useState("supply");
  const [tab, setTab] = useState("supply");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(null);
  const [useCollateral, setUseCollateral] = useState(true);
  const [search, setSearch] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [pickerOpen, setPickerOpen] = useState(false);

  // Sync selected with URL param when entering detail view.
  useEffect(() => {
    if (detailSym && detailSym !== "mINR") setSelected(detailSym);
    if (detailSym) { setTab("supply"); setAmount(""); setDetailTab("supply"); }
  }, [detailSym]);

  // Close filter/picker dropdowns on outside click.
  useEffect(() => {
    const h = (e) => {
      if (!e.target.closest(".filter-wrap")) setFilterOpen(false);
      if (!e.target.closest(".ap-picker-wrap")) setPickerOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const loadMarket = useCallback(async () => {
    const assets = [];
    let totalMarketValue = 0;
    let totalBorrowed = 0;
    try {
      const [debtNorm, idx] = await Promise.all([
        contracts.pool.read("totalDebtNormalized", []),
        contracts.pool.read("currentIndex", []),
      ]);
      totalBorrowed = Number(debtNorm) / 1e18 * (Number(idx) / 1e18);
    } catch { /* ignore */ }

    for (const sym of LENDABLE) {
      const addr = CONTRACTS.tokens[sym];
      try {
        const [collTotal, cfg, price] = await Promise.all([
          contracts.pool.read("collateralTotal", [addr]),
          contracts.pool.read("assets", [addr]),
          contracts.oracle.read("getRawPrice", [sym]).then(([p]) => p),
        ]);
        const priceNum = Number(price) / 1e8;
        const value = Number(collTotal) / 1e18 * priceNum;
        totalMarketValue += value;
        assets.push({
          sym, addr, collTotal, priceNum,
          ltv: cfg[1], liqThreshold: cfg[2],
          supplyRate: 0,
          value,
        });
      } catch { /* skip */ }
    }
    setMarket({
      assets,
      totals: {
        market: totalMarketValue,
        available: Math.max(0, totalMarketValue - totalBorrowed),
        borrowed: totalBorrowed,
      },
    });
  }, [contracts]);

  const loadAccount = useCallback(async () => {
    if (!account) { setAccountData(null); setBalances({}); setCollateralOf({}); return; }
    const bals = {};
    const colls = {};
    for (const sym of LENDABLE) {
      const addr = CONTRACTS.tokens[sym];
      bals[sym] = await contracts.token(addr).read("balanceOf", [account]).catch(() => 0n);
      colls[sym] = await contracts.pool.read("collateralOf", [account, addr]).catch(() => 0n);
    }
    setBalances(bals);
    setCollateralOf(colls);
    try {
      const m = await contracts.minr.read("balanceOf", [account]).catch(() => 0n);
      setMinrBal(m);
    } catch { /* ignore */ }
    try {
      const [acct, debt, power] = await Promise.all([
        contracts.pool.read("accountData", [account]),
        contracts.pool.read("debtOf", [account]),
        contracts.pool.read("borrowingPower", [account]),
      ]);
      setAccountData({ collateral: acct[0], debt: acct[1], health: acct[2], rawDebt: debt, power });
    } catch (e) {
      console.warn("accountData read failed (stale price?):", e.shortMessage || e.message);
    }
  }, [account, contracts]);

  useEffect(() => { loadMarket(); loadAccount(); }, [loadMarket, loadAccount, refreshKey]);

  const run = async (key, fn) => {
    setBusy(key);
    try {
      const hash = await fn();
      onToast?.({ kind: "ok", msg: `confirmed ${hash.slice(0, 10)}…` });
      // Every pool op is also written to Arkiv — the lending side of the journal.
      if (key !== "faucet") {
        try {
          await createLendEvent({
            user: account,
            op: key,
            symbol: selected,
            amount: key === "toggle" ? "0" : amount || "0",
            amountWei: key === "toggle" ? "0" : String(amt()),
            txHash: hash,
            enabled: key === "toggle" ? !useCollateral : undefined,
          });
          onToast?.({ kind: "ok", msg: `${key} recorded on Arkiv ✓` });
        } catch (recordError) {
          onToast?.({ kind: "err", msg: `${key} confirmed on Amoy but Arkiv record failed: ${recordError.message}` });
        }
      }
      await Promise.all([loadMarket(), loadAccount()]);
    } catch (e) {
      onToast?.({ kind: "err", msg: e.shortMessage || e.message });
    } finally {
      setBusy(null);
    }
  };

  const amt = () => toToken(amount || "0");

  const supply = () => run("supply", async () => {
    const t = contracts.token(CONTRACTS.tokens[selected]);
    await t.write("approve", [CONTRACTS.pool, amt()]);
    return contracts.pool.write("supply", [CONTRACTS.tokens[selected], amt()]);
  });
  const withdraw = () => run("withdraw", () => contracts.pool.write("withdraw", [CONTRACTS.tokens[selected], amt()]));
  const borrow = () => run("borrow", () => contracts.pool.write("borrow", [amt()]));
  const repay = () => run("repay", async () => {
    await contracts.minr.write("approve", [CONTRACTS.pool, amt()]);
    return contracts.pool.write("repay", [amt()]);
  });
  const faucet = () => run("faucet", () => contracts.minr.write("faucet", []));
  const toggleCollateral = () => run("toggle", () => contracts.pool.write("setCollateralEnabled", [CONTRACTS.tokens[selected], !useCollateral]));

  const debtValue = () => (accountData ? Number(accountData.debt) / 1e18 : 0);

  const maxFor = (sym) => {
    if (tab === "supply") return fmtToken(balances[sym] ?? 0n, 18, 4).replace(/,/g, "");
    if (tab === "withdraw") return fmtToken(collateralOf[sym] ?? 0n, 18, 4).replace(/,/g, "");
    if (tab === "borrow") return accountData ? fmtToken(accountData.power, 18, 4).replace(/,/g, "") : "0";
    if (tab === "repay") {
      // Can only repay what you owe — never more than the debt.
      const debt = Number(accountData?.rawDebt ?? 0n) / 1e18;
      const wallet = Number(minrBal) / 1e18;
      return String(Math.min(debt, wallet));
    }
    return "0";
  };

  const pct = (p) => {
    const m = maxFor(selected);
    const num = parseFloat(m) || 0;
    setAmount((num * p / 100).toFixed(4));
  };

  const openDetail = (sym) => {
    navigate(`/lend/${symToUrl(sym)}`);
  };

  const isDebtTab = tab === "borrow" || tab === "repay";
  const activeSym = isDebtTab ? "mINR" : selected;
  const activeAsset = market.assets.find((a) => a.sym === selected);
  const selectedColl = collateralOf[selected] ?? 0n;
  const selectedCollActive = selectedColl > 0n;

  const tabs = [
    { key: "supply", label: "Supply" },
    { key: "withdraw", label: "Withdraw" },
    { key: "borrow", label: "Borrow" },
    { key: "repay", label: "Repay" },
  ];

  // ---- Action panel (shared between list + detail views) ----
  const actionPanel = (
    <div className="action-panel">
      <div className="ap-tabs">
        {tabs.map((t) => (
          <button key={t.key} className={`ap-tab ${tab === t.key ? "active" : ""}`} onClick={() => { setTab(t.key); setAmount(""); }}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="ap-body">
        {/* Asset selector with Change button */}
        <div className="ap-picker-wrap">
          <div className="ap-asset-select">
            <div className="ap-asset-left">
              <AssetIcon sym={activeSym} size={36} />
              <div>
                <div className="ap-asset-sym">{activeSym.replace("IND-", "")}</div>
                <div className="ap-asset-meta">
                  {activeSym === "mINR" ? "Stablecoin" : `NSE · LTV ${activeAsset ? Number(activeAsset.ltv) / 100 : 70}%`}
                </div>
              </div>
            </div>
            <button type="button" className="ap-change-btn" onClick={() => setPickerOpen((o) => !o)}>
              Change ▾
            </button>
          </div>
          {pickerOpen && (
            <div className="ap-picker-menu">
              {LENDABLE.map((s) => {
                const a = market.assets.find((x) => x.sym === s);
                return (
                  <button key={s} className={`ap-picker-item ${selected === s ? "active" : ""}`}
                    onClick={() => { setSelected(s); setTab("supply"); setAmount(""); setPickerOpen(false); }}>
                    <AssetIcon sym={s} size={24} />
                    <span>{s.replace("IND-", "")}</span>
                    {a && <span className="ap-picker-ltv">LTV {Number(a.ltv) / 100}%</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Amount input */}
        <div className="ap-amount-wrap">
          <div className="ap-amount-label">
            {tab === "supply" ? "Amount to supply" : tab === "withdraw" ? "Amount to withdraw" : tab === "borrow" ? "Amount to borrow" : "Amount to repay"}
          </div>
          <div className="ap-amount-box">
            <input
              type="number" min="0" step="any" placeholder="0.0"
              value={amount} onChange={(e) => setAmount(e.target.value)}
            />
            <span className="ap-amount-sym">{activeSym.replace("IND-", "")}</span>
          </div>
          <div className="ap-amount-sub">
            <span>Available: {fmtToken(
              tab === "supply" ? (balances[selected] ?? 0n)
              : tab === "withdraw" ? (collateralOf[selected] ?? 0n)
              : tab === "borrow" ? (accountData?.power ?? 0n)
              : toToken(maxFor("repay")), 18, 4)} {tab === "borrow" || tab === "repay" ? "mINR" : activeSym.replace("IND-", "")}{tab === "supply" && activeAsset ? ` (${curSym}${fmtInr((Number(balances[selected] ?? 0n) / 1e18) * activeAsset.priceNum)})` : ""}{tab === "repay" ? " (your debt)" : ""}</span>
            <button type="button" className="ap-max-btn" onClick={() => pct(100)}>MAX</button>
          </div>
        </div>

        {/* Use as collateral toggle */}
        {tab === "supply" && (
          <div className="coll-card">
            <div>
              <div className="coll-title">Use as collateral</div>
              <div className="coll-desc">Allow borrowing against this asset</div>
            </div>
            <button
              type="button"
              className={`switch ${useCollateral ? "on" : ""}`}
              role="switch"
              aria-checked={useCollateral}
              onClick={() => setUseCollateral((v) => !v)}
            >
              <span className="knob" />
            </button>
          </div>
        )}

        {/* Quick percent buttons */}
        <div className="ap-pct-row">
          {[25, 50, 75, 100].map((p) => (
            <button key={p} onClick={() => pct(p)}>{p === 100 ? "Max" : `${p}%`}</button>
          ))}
        </div>

        {/* Collateral summary box */}
        <div className="ap-summary">
          <div className="ap-sum-row">
            <span className="k">Collateral value (100%)</span>
            <span className="v">{curSym}{fmtInr(accountData ? Number(accountData.collateral) / 1e18 : 0)}</span>
          </div>
          <div className="ap-sum-row">
            <span className="k">Borrowing limit ({activeAsset ? Number(activeAsset.ltv) / 100 : 70}%)</span>
            <span className="v">{curSym}{fmtInr(accountData ? Number(accountData.power) / 1e18 : 0)}</span>
          </div>
          <div className="ap-sum-row">
            <span className="k">Your current borrow</span>
            <span className="v">{curSym}{fmtInr(accountData ? Number(accountData.debt) / 1e18 : 0)}</span>
          </div>
          <div className="ap-sum-row highlight">
            <span className="k">Remaining borrowing power</span>
            <span className="v green">{curSym}{fmtInr(accountData ? Number(accountData.power) / 1e18 : 0)}</span>
          </div>
        </div>

        {/* APYs */}
        <div className="ap-apy-row">
          <span>Supply APY <strong>0.00%</strong></span>
          <span>Borrow APY <strong>{activeSym === "mINR" ? "5.00%" : "—"}</strong></span>
        </div>

        {/* CTA */}
        {!account ? (
          <button className="ap-cta" onClick={wallet.connect}>Connect Wallet</button>
        ) : tab === "supply" ? (
          <button className="ap-cta" disabled={!!busy || !amount} onClick={supply}>
            {busy === "supply" ? "Supplying…" : `Supply ${activeSym.replace("IND-", "")}`}
          </button>
        ) : tab === "withdraw" ? (
          <button className="ap-cta" disabled={!!busy || !amount} onClick={withdraw}>
            {busy === "withdraw" ? "Withdrawing…" : `Withdraw ${activeSym.replace("IND-", "")}`}
          </button>
        ) : tab === "borrow" ? (
          <button className="ap-cta" disabled={!!busy || !amount || !marketOpen} onClick={borrow}>
            {busy === "borrow" ? "Borrowing…" : marketOpen ? "Borrow mINR" : "Market closed"}
          </button>
        ) : (
          <button className="ap-cta" disabled={!!busy || !amount} onClick={repay}>
            {busy === "repay" ? "Repaying…" : "Repay mINR"}
          </button>
        )}

        <div className="ap-note">
          <span className="ap-note-icon">ⓘ</span> You'll review and confirm the transaction in your wallet.
        </div>

        <div className="tt-hint">
          Borrow is gated to NSE hours (Mon–Fri 09:15–15:30 IST). Supply / repay / withdraw work 24/7.
        </div>

        <div className="divider" />
        <button className="sm" style={{ width: "100%" }} disabled={!!busy} onClick={faucet}>
          {busy === "faucet" ? "Claiming…" : "Claim 10,000 mINR (testnet faucet)"}
        </button>
      </div>
    </div>
  );

  // ---- Per-asset detail view ----
  if (detailSym) {
    const isMinr = detailSym === "mINR";
    const asset = market.assets.find((a) => a.sym === detailSym);
    const userColl = collateralOf[detailSym] ?? 0n;
    const userCollValue = asset ? Number(userColl) / 1e18 * asset.priceNum : 0;
    const totalSupplied = isMinr ? Infinity : Number(asset?.collTotal ?? 0n) / 1e18;
    const totalSuppliedValue = isMinr ? Infinity : asset?.value ?? 0;
    const totalBorrowed = market.totals.borrowed;
    const ltvPct = asset ? Number(asset.ltv) / 100 : 0;
    const liqPct = asset ? Number(asset.liqThreshold) / 100 : 0;
    const shortName = detailSym.replace("IND-", "");

    return (
      <div className="asset-detail">
        <div className="ad-topbar">
          <button className="ad-back" onClick={() => navigate("/lend")}>View Markets</button>
          <div className="ad-top-stats">
            <div className="ad-top-stat">
              <span className="k">Net Worth</span>
              <span className="v">{curSym}{fmtInr(accountData ? Number(accountData.collateral) / 1e18 : 0)}</span>
            </div>
            <div className="ad-top-stat">
              <span className="k">Health Factor</span>
              <span className={`v ${healthClass(accountData?.health)}`}>{accountData ? fmtHealth(accountData.health) : "∞"}</span>
            </div>
            <div className="ad-top-stat">
              <span className="k">Collateral</span>
              <span className="v">{userColl > 0n ? `${fmtToken(userColl, 18, 4)} ${shortName}` : "None"}</span>
            </div>
          </div>
        </div>

        <div className="ad-header card">
          <div className="ad-header-left">
            <AssetIcon sym={detailSym} size={48} />
            <div>
              <div className="ad-title">{shortName}</div>
              <div className="ad-sub">
                {isMinr ? "Mock Indian Rupee" : `NSE · ${shortName}`}
                <span className="ad-tag">{isMinr ? "Stablecoin" : "Isolated"}</span>
              </div>
            </div>
          </div>
          <div className="ad-header-right">
            <div className="ad-price">{curSym}{fmtInr(asset?.priceNum ?? 1)}</div>
            <div className="ad-price-label">Oracle price</div>
          </div>
        </div>

        <div className="ad-stats card">
          <div className="ad-stat">
            <div className="k" title="Total amount supplied to this market">Total Supply ⓘ</div>
            <div className="v">
              {isMinr ? "∞" : `${fmtToken(asset?.collTotal ?? 0n, 18, 2)} ${shortName}`}
              <div className="sub">{isMinr ? "minted on borrow" : `${curSym}${fmtInr(totalSuppliedValue)}`}</div>
            </div>
          </div>
          <div className="ad-stat">
            <div className="k" title="Total mINR borrowed against all collateral">Total Borrow ⓘ</div>
            <div className="v">
              {curSym}{fmtInr(totalBorrowed)}
              <div className="sub">mINR debt</div>
            </div>
          </div>
          <div className="ad-stat">
            <div className="k" title="Supply minus borrow">Available ⓘ</div>
            <div className="v">
              {isMinr ? "∞" : `${curSym}${fmtInr(totalSuppliedValue)}`}
              <div className="sub">available to borrow</div>
            </div>
          </div>
          <div className="ad-stat">
            <div className="k" title="Borrowed / Supplied">Utilization ⓘ</div>
            <div className="v">
              {isMinr ? "—" : "0.00%"}
              <div className="sub">{isMinr ? "" : "no borrow market"}</div>
            </div>
          </div>
        </div>

        <div className="ad-positions">
          <div className="ad-pos-card deposited">
            <div className="ad-pos-head">
              <span className="dot green" />
              Your Deposited Assets: <strong>{curSym}{fmtInr(userCollValue)}</strong>
            </div>
            <div className="ad-pos-body">
              {userColl > 0n ? (
                <div className="ad-pos-row">
                  <AssetIcon sym={detailSym} size={26} />
                  <span>{fmtToken(userColl, 18, 4)} {shortName}</span>
                  <span className="mut">{curSym}{fmtInr(userCollValue)}</span>
                </div>
              ) : (
                <div className="ad-pos-empty">Nothing deposited yet.</div>
              )}
            </div>
          </div>
          <div className="ad-pos-card borrowed">
            <div className="ad-pos-head">
              <span className="dot pink" />
              Your Borrowed Assets: <strong>{curSym}{fmtInr(accountData ? Number(accountData.debt) / 1e18 : 0)}</strong>
            </div>
            <div className="ad-pos-body">
              {accountData && Number(accountData.debt) > 0 ? (
                <div className="ad-pos-row">
                  <AssetIcon sym="mINR" size={26} />
                  <span>{fmtToken(accountData.debt, 18, 4)} mINR</span>
                  <span className="mut">{curSym}{fmtInr(Number(accountData.debt) / 1e18)}</span>
                </div>
              ) : (
                <div className="ad-pos-empty">
                  Nothing borrowed yet.
                  {accountData && Number(accountData.collateral) > 0 && (
                    <span style={{ color: "var(--accent-2)", marginLeft: 6, cursor: "pointer", textDecoration: "underline" }}
                      onClick={() => { setTab("borrow"); setAmount(""); }}>
                      Borrow against your collateral!
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="ad-body-layout">
          <div className="ad-main">
            <div className="ad-info-tabs">
              {[
                { key: "supply", label: "Supply Info" },
                { key: "borrow", label: "Borrow Info" },
                { key: "token", label: "Token Details" },
              ].map((t) => (
                <button key={t.key} className={`ad-info-tab ${detailTab === t.key ? "active" : ""}`}
                  onClick={() => setDetailTab(t.key)}>
                  {t.label}
                </button>
              ))}
            </div>

            {detailTab === "supply" && (
              <div className="ad-info-card card">
                <h3>Supply Info</h3>
                <div className="ad-info-grid">
                  <div>
                    <div className="k">Total Supplied</div>
                    <div className="v">{isMinr ? "∞" : `${fmtToken(asset?.collTotal ?? 0n, 18, 2)} ${shortName}`}</div>
                    <div className="sub">{isMinr ? "minted on borrow" : `${curSym}${fmtInr(totalSuppliedValue)}`}</div>
                  </div>
                  <div>
                    <div className="k">Supply APY</div>
                    <div className="v">0.00%</div>
                    <div className="sub">collateral only</div>
                  </div>
                  <div>
                    <div className="k">Supply Cap</div>
                    <div className="v">{isMinr ? "∞" : "No cap"}</div>
                    <div className="sub">{isMinr ? "" : "uncapped market"}</div>
                  </div>
                </div>
              </div>
            )}

            {detailTab === "borrow" && (
              <div className="ad-info-card card">
                <h3>Borrow Info</h3>
                {isMinr ? (
                  <div className="ad-info-grid">
                    <div>
                      <div className="k">Total Borrowed</div>
                      <div className="v">{curSym}{fmtInr(totalBorrowed)}</div>
                      <div className="sub">mINR debt outstanding</div>
                    </div>
                    <div>
                      <div className="k">Borrow APY</div>
                      <div className="v" style={{ color: "var(--up)" }}>5.00%</div>
                      <div className="sub">fixed rate</div>
                    </div>
                    <div>
                      <div className="k">Debt Ceiling</div>
                      <div className="v">None</div>
                      <div className="sub">no hard limit</div>
                    </div>
                  </div>
                ) : (
                  <div className="ad-info-grid">
                    <div>
                      <div className="k">Borrowable</div>
                      <div className="v" style={{ color: "var(--faint)" }}>—</div>
                      <div className="sub">stocks are collateral-only</div>
                    </div>
                    <div>
                      <div className="k">Borrow APY</div>
                      <div className="v" style={{ color: "var(--faint)" }}>—</div>
                      <div className="sub">no direct borrow market</div>
                    </div>
                    <div>
                      <div className="k">Debt Ceiling</div>
                      <div className="v" style={{ color: "var(--faint)" }}>—</div>
                      <div className="sub">not applicable</div>
                    </div>
                  </div>
                )}
                <div className="tt-hint" style={{ marginTop: 14 }}>
                  Borrow mINR by supplying collateral first. Gated to NSE hours.
                </div>
              </div>
            )}

            {detailTab === "token" && (
              <div className="ad-info-card card">
                <h3>Token Details</h3>
                <div className="ad-token-rows">
                  <div className="ad-token-row">
                    <span className="k">Contract</span>
                    <span className="v mono">{isMinr ? CONTRACTS.minr : (asset?.addr || "—")}</span>
                  </div>
                  <div className="ad-token-row">
                    <span className="k">Chain</span>
                    <span className="v">Polygon Amoy (80002)</span>
                  </div>
                  <div className="ad-token-row">
                    <span className="k">Type</span>
                    <span className="v">{isMinr ? "Stablecoin (mock INR)" : "Synthetic equity (ERC-20)"}</span>
                  </div>
                  <div className="ad-token-row">
                    <span className="k">Decimals</span>
                    <span className="v">18</span>
                  </div>
                  <div className="ad-token-row">
                    <span className="k">Your wallet balance</span>
                    <span className="v">{fmtToken(isMinr ? minrBal : (balances[detailSym] ?? 0n), 18, 4)}</span>
                  </div>
                  <div className="ad-token-row">
                    <span className="k">Your supplied</span>
                    <span className="v">{fmtToken(userColl, 18, 4)}</span>
                  </div>
                </div>
              </div>
            )}

            <div className="ad-info-card card">
              <div className="ad-coll-header">
                <h3>Collateral Usage</h3>
                <span className="ad-coll-badge">
                  {isMinr ? "× Not collateral" : "✓ Isolated collateral"}
                </span>
              </div>
              <div className="ad-info-grid">
                <div>
                  <div className="k" title="Max loan-to-value">Max LTV ⓘ</div>
                  <div className="v">{isMinr ? "0.0%" : `${ltvPct}%`}</div>
                </div>
                <div>
                  <div className="k" title="Health factor drops below 1x at this threshold">Liquidation threshold ⓘ</div>
                  <div className="v">{isMinr ? "0.0%" : `${liqPct}%`}</div>
                </div>
                <div>
                  <div className="k">Liquidation penalty</div>
                  <div className="v">{isMinr ? "0.0%" : "5.0%"}</div>
                </div>
                <div>
                  <div className="k">Isolation Mode ⓘ</div>
                  <div className="v">{isMinr ? "No" : "Yes"}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="ad-action">{actionPanel}</div>
        </div>
      </div>
    );
  }

  // ---- Market list view ----
  const depositedPositions = LENDABLE.filter((s) => (collateralOf[s] ?? 0n) > 0n).map((s) => {
    const a = market.assets.find((x) => x.sym === s);
    const amt = collateralOf[s];
    const val = a ? Number(amt) / 1e18 * a.priceNum : 0;
    return { sym: s, amt, val };
  });
  const totalDepositedValue = depositedPositions.reduce((s, p) => s + p.val, 0);
  const totalDebtValue = accountData ? Number(accountData.debt) / 1e18 : 0;
  const borrowLimit = accountData ? Number(accountData.power) / 1e18 : 0;
  const borrowLimitPct = activeAsset ? Number(activeAsset.ltv) / 10000 : 0.7;

  const filteredAssets = market.assets.filter((a) => {
    if (search && !a.sym.replace("IND-", "").toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === "deposited" && (collateralOf[a.sym] ?? 0n) === 0n) return false;
    // "Available" = you hold some in the wallet (ready to supply).
    if (filter === "available" && (balances[a.sym] ?? 0n) === 0n) return false;
    return true;
  });

  return (
    <div>
      {/* Top stats cards row */}
      <div className="lp-stats">
        <div className="lp-stat-card">
          <div className="lp-stat-icon purple">▦</div>
          <div className="lp-stat-body">
            <div className="lp-stat-label">Total Supplied</div>
            <div className="lp-stat-value">{curSym}{fmtInr(totalDepositedValue)} <span className="lp-stat-delta up">▲ 0.00%</span></div>
          </div>
        </div>
        <div className="lp-stat-card">
          <div className="lp-stat-icon orange">◎</div>
          <div className="lp-stat-body">
            <div className="lp-stat-label">Available to Borrow ⓘ</div>
            <div className="lp-stat-value orange">{curSym}{fmtInr(borrowLimit)}</div>
            <div className="lp-stat-sub">{Math.round(borrowLimitPct * 100)}% of collateral value</div>
          </div>
        </div>
        <div className="lp-stat-card">
          <div className="lp-stat-icon purple">▣</div>
          <div className="lp-stat-body">
            <div className="lp-stat-label">Total Borrowed</div>
            <div className="lp-stat-value">{curSym}{fmtInr(totalDebtValue)}</div>
            <div className="lp-stat-sub">{totalDebtValue > 0 ? `${((totalDebtValue / Math.max(borrowLimit, 0.01)) * 100).toFixed(2)}% of limit` : "0.00% of limit"}</div>
          </div>
        </div>
        <div className="lp-stat-card networth">
          <div className="lp-stat-icon green">V</div>
          <div className="lp-stat-body">
            <div className="lp-stat-label">Net Worth</div>
            <div className="lp-stat-value">{curSym}{fmtInr(accountData ? Number(accountData.collateral) / 1e18 : 0)}</div>
            <div className="lp-stat-subrow">
              <span>Health Factor <strong className={healthClass(accountData?.health)}>{accountData ? fmtHealth(accountData.health) : "∞"}</strong></span>
              <span>{depositedPositions.length} asset{depositedPositions.length !== 1 ? "s" : ""} supplied</span>
            </div>
          </div>
        </div>
      </div>

      <div className="lend-layout">
        {/* Left: Your Assets table */}
        <div className="lp-assets-card card">
          <div className="lp-assets-head">
            <div>
              <div className="lp-assets-title">Your Assets</div>
              <div className="lp-assets-sub">Supply assets to earn yield and/or use them as collateral to borrow mINR.</div>
            </div>
            <div className="lp-assets-controls">
              <div className="lp-search">
                <span className="lp-search-icon">🔍</span>
                <input
                  type="text"
                  placeholder="Search assets (e.g. RELIANCE, TCS, INFY)"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="filter-wrap">
                <button className="lp-filter-btn" onClick={() => setFilterOpen((o) => !o)}>
                  {filter === "all" ? "All assets" : filter === "deposited" ? "Deposited" : "In wallet"} ▾
                </button>
                {filterOpen && (
                  <div className="lp-filter-menu">
                    <button onClick={() => { setFilter("all"); setFilterOpen(false); }}>All assets</button>
                    <button onClick={() => { setFilter("deposited"); setFilterOpen(false); }}>Deposited</button>
                    <button onClick={() => { setFilter("available"); setFilterOpen(false); }}>In wallet</button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="lp-table">
            <div className="lp-table-head">
              <div>Asset ▾</div>
              <div>Supplied</div>
              <div title="Yield earned by suppliers">Supply APY ⓘ</div>
              <div title="Max loan-to-value">LTV ⓘ</div>
              <div>Collateral</div>
              <div title="Your borrowed amount">Borrowed ⓘ</div>
              <div>Actions</div>
            </div>

            {filteredAssets.map((a) => {
              const short = a.sym.replace("IND-", "");
              const userSupplied = collateralOf[a.sym] ?? 0n;
              const userSuppliedVal = Number(userSupplied) / 1e18 * a.priceNum;
              const collOn = userSupplied > 0n;
              const walletBal = balances[a.sym] ?? 0n;
              const walletVal = Number(walletBal) / 1e18 * a.priceNum;
              return (
                <div
                  key={a.sym}
                  className={`lp-row ${selected === a.sym ? "selected" : ""}`}
                  onClick={() => { setSelected(a.sym); setTab("supply"); setAmount(""); }}
                >
                  <div className="lp-asset">
                    <AssetIcon sym={a.sym} size={40} />
                    <div>
                      <div
                        className="lp-asset-name mr-name-link"
                        onClick={(e) => { e.stopPropagation(); openDetail(a.sym); }}
                      >
                        {short}
                      </div>
                      <div className="lp-asset-meta">
                        <span className="mr-tag collateral">Isolated</span>
                        <span>NSE · LTV {Number(a.ltv) / 100}%</span>
                      </div>
                    </div>
                  </div>
                  <div className="lp-cell">
                    <div className="lp-cell-main">{fmtToken(userSupplied, 18, 2)}</div>
                    <div className="lp-cell-sub">
                      {walletBal > 0n
                        ? <>{fmtToken(walletBal, 18, 2)} in wallet · {curSym}{fmtInr(walletVal)}</>
                        : <>{curSym}{fmtInr(userSuppliedVal)}</>}
                    </div>
                  </div>
                  <div className="lp-cell">
                    <div className="lp-cell-main">0.00%</div>
                  </div>
                  <div className="lp-cell">
                    <div className="lp-cell-main">{Number(a.ltv) / 100}%</div>
                  </div>
                  <div className="lp-cell">
                    <button
                      type="button"
                      className={`lp-toggle ${collOn ? "on" : ""}`}
                      onClick={(e) => { e.stopPropagation(); if (!collOn) { setSelected(a.sym); setTab("supply"); } }}
                      title={collOn ? "Collateral enabled" : "Enable after supply"}
                    >
                      <span className="knob" />
                    </button>
                  </div>
                  <div className="lp-cell">
                    <div className="lp-cell-main">₹0.00</div>
                    <div className="lp-cell-sub">0.00%</div>
                  </div>
                  <div className="lp-cell">
                    <button
                      type="button"
                      className="select-asset"
                      title="Select Asset"
                      onClick={(e) => { e.stopPropagation(); setSelected(a.sym); setTab("supply"); setAmount(""); }}
                    >
                      ›
                    </button>
                  </div>
                </div>
              );
            })}

            {/* mINR row */}
            <div
              className={`lp-row ${selected === "mINR" ? "selected" : ""}`}
              onClick={() => { setSelected("mINR"); setTab("borrow"); setAmount(""); }}
            >
              <div className="lp-asset">
                <AssetIcon sym="mINR" size={40} />
                <div>
                  <div
                    className="lp-asset-name mr-name-link"
                    onClick={(e) => { e.stopPropagation(); openDetail("mINR"); }}
                  >
                    mINR
                  </div>
                  <div className="lp-asset-meta">
                    <span className="mr-tag">Stablecoin</span>
                    <span>Mock Indian Rupee</span>
                  </div>
                </div>
              </div>
              <div className="lp-cell">
                <div className="lp-cell-main">∞</div>
                <div className="lp-cell-sub">minted on borrow</div>
              </div>
              <div className="lp-cell"><div className="lp-cell-main mut">—</div></div>
              <div className="lp-cell"><div className="lp-cell-main mut">—</div></div>
              <div className="lp-cell"><div className="lp-cell-main mut">—</div></div>
              <div className="lp-cell">
                <div className="lp-cell-main">{curSym}{fmtInr(totalDebtValue)}</div>
                <div className="lp-cell-sub green">5.00%</div>
              </div>
              <div className="lp-cell">
                <button
                  type="button"
                  className="select-asset"
                  title="Select Asset"
                  onClick={(e) => { e.stopPropagation(); setSelected("mINR"); setTab("borrow"); setAmount(""); }}
                >
                  ›
                </button>
              </div>
            </div>
          </div>
        </div>

        {actionPanel}
      </div>
    </div>
  );
}
