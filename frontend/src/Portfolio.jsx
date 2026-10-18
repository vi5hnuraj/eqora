import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LENDABLE, CONTRACTS } from "./config.js";
import { fmtInr, fmtToken, fmtHealth, healthClass } from "./format.js";
import { useCurrency } from "./currency.jsx";
import { listJournal, listLoans } from "./api.js";

export default function Portfolio({ wallet, refreshKey, onToast }) {
  const { currency, symbol: curSym } = useCurrency();
  const { account, contracts } = wallet;
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [positions, setPositions] = useState([]);
  const [journal, setJournal] = useState([]);
  const [memos, setMemos] = useState([]);
  const [journalOpen, setJournalOpen] = useState(true);

  const load = useCallback(async () => {
    if (!account) { setData(null); setPositions([]); setJournal([]); setMemos([]); return; }
    try {
      const [acct, debt, power] = await Promise.all([
        contracts.pool.read("accountData", [account]),
        contracts.pool.read("debtOf", [account]),
        contracts.pool.read("borrowingPower", [account]),
      ]);
      setData({ collateral: acct[0], debt: acct[1], health: acct[2], power });

      const pos = [];
      for (const sym of LENDABLE) {
        const addr = CONTRACTS.tokens[sym];
        const [bal, val] = await Promise.all([
          contracts.pool.read("collateralOf", [account, addr]),
          contracts.pool.read("collateralValueOf", [account, addr]),
        ]);
        if (bal > 0n) pos.push({ sym, bal, value: val });
      }
      setPositions(pos);

      const [jp, mp] = await Promise.all([
        listJournal({ user: account, limit: 20 }).catch(() => ({ entities: [] })),
        listLoans({ user: account, limit: 10 }).catch(() => ({ entities: [] })),
      ]);
      setJournal(jp.entities || []);
      setMemos(mp.entities || []);
    } catch (e) { console.error(e); }
  }, [account, contracts]);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (!account) {
    return (
      <div className="about-card">
        <h3>Portfolio</h3>
        <p>Connect your wallet to see your supplied collateral, debt position, health factor, and your immutable Arkiv trade journal.</p>
        <button className="primary" onClick={wallet.connect}>Connect Wallet</button>
      </div>
    );
  }

  const collateralVal = data ? Number(data.collateral) / 1e18 : 0;
  const debtVal = data ? Number(data.debt) / 1e18 : 0;
  const netWorth = collateralVal - debtVal;
  const healthNum = data?.health ? Number(data.health) / 1e18 : null;
  const healthPct = healthNum == null ? 0 : healthNum >= 3 ? 100 : Math.max(0, Math.min(100, ((healthNum - 1) / 2) * 100));
  const suppliedVal = positions.reduce((s, p) => s + Number(p.value) / 1e18, 0);

  const goLend = () => navigate("/lend");
  const goTrade = () => navigate("/trade");

  const tradeRows = journal.map((e) => ({ ...e, pnl: Number(e.attributes?.pnl_bps ?? 0) }));
  const wins = tradeRows.filter((r) => r.pnl > 0).length;
  const netBps = tradeRows.reduce((s, r) => s + r.pnl, 0);

  return (
    <div>
      {/* Overview + Collateral */}
      <div className="po-layout">
        <div className="card po-card">
          <div className="po-head">
            <div className="po-head-icon" style={{ color: "var(--up)" }}>▦</div>
            <div>
              <div className="po-head-title">Overview</div>
              <div className="po-head-sub">Your lending position at a glance</div>
            </div>
          </div>
          <div className="card-body">
            <div className="po-tiles">
              <div className="po-tile">
                <div className="po-tile-k">Net Worth</div>
                <div className="po-tile-v">{curSym}{fmtInr(netWorth)}</div>
              </div>
              <div className="po-tile">
                <div className="po-tile-k">Health Factor</div>
                <div className={`po-tile-v ${healthClass(data?.health)}`}>{data ? fmtHealth(data.health) : "—"}</div>
                <div className="po-bar"><div className="po-bar-fill" style={{ width: `${healthPct}%` }} /></div>
              </div>
              <div className="po-tile">
                <div className="po-tile-k">Collateral Value</div>
                <div className="po-tile-v">{curSym}{fmtInr(collateralVal)}</div>
              </div>
              <div className="po-tile">
                <div className="po-tile-k">Debt (mINR)</div>
                <div className="po-tile-v">{fmtToken(data?.debt ?? 0n, 18, 2)}</div>
              </div>
              <div className="po-tile">
                <div className="po-tile-k">Journal trades</div>
                <div className="po-tile-v">{journal.length}</div>
                <div className="po-tile-s">recorded on Arkiv</div>
              </div>
              <div className="po-tile">
                <div className="po-tile-k">Wins / Net P&amp;L</div>
                <div className="po-tile-v" style={{ color: netBps > 0 ? "var(--up)" : netBps < 0 ? "#ff6b6b" : undefined }}>
                  {wins}W · {netBps >= 0 ? "+" : ""}{netBps} bps
                </div>
                <div className="po-tile-s">across all records</div>
              </div>
            </div>

            <div className="po-comp-head">
              <span>Portfolio composition</span>
              <span className="po-comp-tag">Your position</span>
            </div>
            <div className="po-comp">
              <div className="po-box supplied">
                <div className="po-box-k"><span className="dot" /> Supplied assets</div>
                <div className="po-box-v">{curSym}{fmtInr(suppliedVal)}</div>
                <div className="po-box-sub">{positions.length ? `${positions.length} asset${positions.length > 1 ? "s" : ""} supplied` : "No supplied assets"}</div>
              </div>
              <div className="po-arrow">→</div>
              <div className="po-box borrowed">
                <div className="po-box-k"><span className="dot" /> Borrowed assets</div>
                <div className="po-box-v">{curSym}{fmtInr(debtVal)}</div>
                <div className="po-box-sub">{debtVal > 0 ? "mINR debt open" : "Nothing borrowed yet"}</div>
              </div>
            </div>
            <div className="po-foot">
              Borrowing power <strong className="mono">{curSym}{fmtInr(data ? Number(data.power) / 1e18 : 0)}</strong> ·
              borrowing is supported by assets you supply as collateral.
            </div>
          </div>
        </div>

        <div className="po-right">
          <div className="card po-card">
            <div className="po-head">
              <div className="po-head-icon" style={{ color: "var(--accent-2)" }}>⛨</div>
              <div>
                <div className="po-head-title">Collateral</div>
                <div className="po-head-sub">Assets currently securing your borrowing power</div>
              </div>
            </div>
            <div className="card-body">
              {positions.length === 0 ? (
                <div className="po-empty">
                  <div className="po-empty-t">No collateral enabled</div>
                  <div className="po-empty-s">Supply an eligible asset in Lend to unlock borrowing power.</div>
                </div>
              ) : (
                <div className="po-list">
                  {positions.map((p) => (
                    <div className="po-list-row" key={p.sym}>
                      <span className="po-dot" style={{ background: "var(--up)" }} />
                      <span className="po-list-sym">{p.sym.replace("IND-", "")}</span>
                      <span className="po-list-val mono">{curSym}{fmtInr(Number(p.value) / 1e18)}</span>
                      <span className="mr-tag collateral">Active</span>
                    </div>
                  ))}
                </div>
              )}
              <button className="ap-cta supply" style={{ marginTop: 16 }} onClick={goLend}>Manage collateral</button>
            </div>
          </div>

          {/* Journal trades fill the right column under Collateral */}
          <div className="card acc-card po-journal">
            <button className="acc-head" onClick={() => setJournalOpen(!journalOpen)}>
              <span className="acc-title">
                <span className="acc-chev">{journalOpen ? "▾" : "▸"}</span>
                Recent journal trades (Arkiv)
                <span className="acc-tag">immutable · Tiramisu</span>
              </span>
              <span className="acc-right">
                <span className="acc-count">{journal.length}</span>
                <span className="acc-link" onClick={(ev) => { ev.stopPropagation(); navigate("/activity"); }}>Full journal ↗</span>
              </span>
            </button>
            {journalOpen && (
              <div className="acc-body">
                {journal.length === 0 ? (
                  <div className="empty">
                    No trades recorded yet. <a className="xlink" href="/trade">Record one on Trade →</a>
                  </div>
                ) : (
                  <div className="acc-menu">
                    {tradeRows.map((e) => {
                      const a = e.attributes || {};
                      return (
                        <div className="acc-row" key={e.key}>
                          <span className={`side ${a.side}`}>{(a.side || "?").toUpperCase()}</span>
                          <div className="acc-info">
                            <div className="acc-l1">
                              {String(a.symbol ?? "").replace("IND-", "")}
                              <span className="pill">{a.trade_type === "leverage" ? `${a.leverage}x` : "spot"}</span>
                            </div>
                            <div className="acc-l2 mono">{a.size} @ ₹{a.price}</div>
                          </div>
                          <div className={`pnl ${e.pnl >= 0 ? "pos" : "neg"}`}>{e.pnl >= 0 ? "+" : ""}{e.pnl} bps</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Deposited + Borrowed */}
      <div className="po-layout">
        <div className="card po-card">
          <div className="po-strip supplied">
            <span className="dot" /> Your Deposited Assets:&nbsp;<strong className="mono">{curSym}{fmtInr(suppliedVal)}</strong>
          </div>
          <div className="card-body">
            {positions.length === 0 ? (
              <div className="po-empty-s" style={{ textAlign: "left" }}>
                Nothing deposited yet. <a onClick={goLend} style={{ cursor: "pointer", textDecoration: "underline" }}>Supply some assets to begin!</a>
              </div>
            ) : (
              <div className="po-list">
                {positions.map((p) => (
                  <div className="po-list-row" key={p.sym}>
                    <span className="po-dot" style={{ background: "var(--gold)" }} />
                    <span className="po-list-sym">{p.sym.replace("IND-", "")}</span>
                    <span className="po-list-bal mono muted">{fmtToken(p.bal, 18, 4)}</span>
                    <span className="po-list-val mono">{curSym}{fmtInr(Number(p.value) / 1e18)}</span>
                    <span className="mr-tag collateral">Isolated</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="card po-card">
          <div className="po-strip borrowed">
            <span className="dot" /> Your Borrowed Assets:&nbsp;<strong className="mono">{curSym}{fmtInr(debtVal)}</strong>
          </div>
          <div className="card-body">
            {debtVal <= 0 ? (
              <div className="po-empty-s" style={{ textAlign: "left" }}>
                Nothing borrowed yet. To start borrowing, <a onClick={goLend} style={{ cursor: "pointer", textDecoration: "underline" }}>supply some collateral</a>
              </div>
            ) : (
              <div className="po-list">
                <div className="po-list-row">
                  <span className="po-dot" style={{ background: "var(--accent-2)" }} />
                  <span className="po-list-sym">mINR</span>
                  <span className="po-list-bal mono muted">{fmtToken(data?.debt ?? 0n, 18, 4)} mINR</span>
                  <span className="po-list-val mono">{curSym}{fmtInr(debtVal)}</span>
                  <span className="mr-tag">Debt</span>
                </div>
                <div className="po-list-row">
                  <span className="po-dot" style={{ background: "var(--warn)" }} />
                  <span className="po-list-sym">Health</span>
                  <span className="po-list-val mono">Liquidation at −{healthNum ? Math.max(0, ((1 - 1 / healthNum) * 100)).toFixed(1) : "0.0"}%</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
