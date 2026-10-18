import { useCallback, useEffect, useState } from "react";
import { listLoans, listLendEvents, syncLoan } from "./api.js";
import { fetchArkivStatus, entityUrl } from "./arkiv.js";
import { CONTRACTS } from "./config.js";
import { fmtInr, healthClass, short, timeAgo } from "./format.js";
import { useCurrency } from "./currency.jsx";

export default function RiskList({ wallet, onToast }) {
  const { currency, symbol: curSym } = useCurrency();
  const { account, contracts } = wallet;
  const [memos, setMemos] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chain, setChain] = useState(null);

  useEffect(() => {
    fetchArkivStatus().then(setChain).catch(() => {});
  }, []);

  // expiresAt on Arkiv is a BLOCK NUMBER, not a timestamp.
  const leaseLabel = (m) => {
    if (!m.expiresAt) return "7d lease";
    if (!chain?.currentBlock) return "7d lease";
    const days = ((Number(m.expiresAt) - chain.currentBlock) * (chain.blockDuration || 1)) / 86_400;
    if (days <= 0) return "expired";
    return `lease ${days < 1 ? "<1d" : `${Math.ceil(days)}d`} left`;
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Global risk list: any open memo with health factor below 1.10.
      const page = await listLoans({ healthFactorBelow: "1.10", limit: 50 });
      const mine = account ? await listLoans({ user: account, limit: 20 }) : { entities: [] };
      const seen = new Set();
      const merged = [...page.entities, ...mine.entities].filter((e) => {
        if (seen.has(e.key)) return false;
        seen.add(e.key);
        return true;
      });
      setMemos(merged);
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setLoading(false);
    }
  }, [account, onToast]);

  useEffect(() => { load(); }, [load]);

  // Recent pool operations, written to Arkiv by the Lend page after each Amoy tx.
  useEffect(() => {
    if (!account) { setEvents([]); return; }
    let alive = true;
    const tick = () => listLendEvents({ user: account, limit: 8 })
      .then((page) => { if (alive) setEvents(page.entities); })
      .catch(() => {});
    tick();
    const id = setInterval(tick, 20_000);
    return () => { alive = false; clearInterval(id); };
  }, [account]);

  const sync = async () => {
    if (!account) return;
    setBusy(true);
    try {
      const acct = await contracts.pool.read("accountData", [account]);
      const result = await syncLoan({
        user: account,
        collateralSymbol: "IND-RELIANCE",
        collateralAmount: (Number(acct[0]) / 1e8).toFixed(4),
        debtMINR: (Number(acct[1]) / 1e18).toFixed(4),
        healthFactor: (Number(acct[2]) / 1e18 > 1e15 ? "999" : (Number(acct[2]) / 1e18).toFixed(4)),
        pool: CONTRACTS.pool,
      });
      onToast?.({ kind: "ok", msg: `loan memo ${result.action} on Arkiv` });
      await load();
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div className="memo-head">
          <h2>Position memos</h2>
          <span className="sub">Arkiv · 7-day lease, renewed by activity</span>
        </div>
        <button className="green sm" disabled={busy || !account} onClick={sync}>
          {busy ? "Syncing…" : account ? "Sync mine →" : "Connect to sync"}
        </button>
      </div>
      <div className="card-body">
        <div className="list">
          {memos.length === 0 && <div className="empty">{loading ? "Loading…" : "No open memos. Positions you sync appear here."}</div>}
          {memos.map((m) => {
            const a = m.attributes || {};
            const hf = a.health_factor;
            return (
              <div className="entry" key={m.key}>
                <div className="body">
                  <div className="l1">{short(a.user)} <span className="sz">{a.collateral_symbol}</span></div>
                  <div className="l2">
                    <span>collateral {fmtInr(Number(a.collateral_amount), 2)}</span>
                    <span>debt {fmtInr(Number(a.debt_minr), 2)}</span>
                    <span className="mono">{short(m.key)}</span>
                    <span>{leaseLabel(m)}</span>
                  </div>
                </div>
                <div className={`pnl ${healthClass(hf ? BigInt(Math.round(Number(hf) * 1e18)) : null)}`}>
                  HF {hf != null ? Number(hf).toFixed(2) : "—"}
                </div>
              </div>
            );
          })}
        </div>
        {events.length > 0 && (
          <div className="lend-events">
            <span className="flabel">lending events — every pool op written to Arkiv (Amoy tx mirrored)</span>
            {events.map((ev) => {
              const a = ev.attributes ?? {};
              const ms = Number(a.created_ms ?? 0);
              return (
                <div className="lend-row" key={ev.key}>
                  <span className="lend-op">{String(a.op ?? "?")}</span>
                  <span className="lend-sym">{String(a.symbol ?? "")}</span>
                  <span className="mono">{String(a.amount ?? "")}</span>
                  <span className="lend-tx" title={`Amoy tx ${a.tx ?? ""}`}>{short(String(a.tx ?? ""))}</span>
                  <span className="lend-time">{ms ? timeAgo(ms) : ""}</span>
                  <a className="xlink" href={entityUrl(ev.key)} target="_blank" rel="noreferrer" title="entity on the Tiramisu explorer">↗</a>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
