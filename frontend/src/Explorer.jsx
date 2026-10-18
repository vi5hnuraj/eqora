import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  fetchAllRecords,
  fetchEntityDirect,
  loadRecordsCache,
  expiresInDays,
  fmtDate,
  fmtDaysLabel,
  entityUrl,
  txUrl,
} from "./arkiv.js";
import { short, timeAgo } from "./format.js";
import Proof from "./Proof.jsx";

// Human-readable names — the Arkiv schema keeps its technical kind strings;
// only the interface speaks plainly.
const HUMAN = {
  trade_journal: { label: "Trade recorded", desc: "Trade execution record" },
  journal_note: { label: "Journal note", desc: "User annotation" },
  loan_memo: { label: "Loan update", desc: "Open loan position" },
  session_snapshot: { label: "Market snapshot", desc: "Market session snapshot" },
  user_profile: { label: "Profile", desc: "Profile information" },
  leaderboard_entry: { label: "Performance record", desc: "Ranking snapshot" },
  lend_event: { label: "Lending action", desc: "Supply/borrow/repay/withdraw mirrored from Amoy" },
};

const LEND_OP = {
  supply: "Collateral supplied",
  borrow: "Loan borrowed",
  repay: "Loan repaid",
  withdraw: "Collateral withdrawn",
  toggle: "Collateral updated",
};

const TABS = [
  { id: "all", label: "All records" },
  { id: "trades", label: "Trades" },
  { id: "notes", label: "Notes" },
  { id: "loans", label: "Loans" },
];

const inTab = (rec, tab) =>
  tab === "all" ||
  (tab === "trades" && rec.kind === "trade_journal") ||
  (tab === "notes" && rec.kind === "journal_note") ||
  (tab === "loans" && (rec.kind === "loan_memo" || rec.kind === "lend_event"));

function fmtAttr(name, value) {
  if (value == null || value === "") return "—";
  if (name === "created_ms" || name === "updated_ms") return fmtDate(Number(value));
  if (name === "pnl_bps") {
    const n = Number(value);
    return <span className={n >= 0 ? "pos" : "neg"}>{n >= 0 ? "+" : ""}{n} bps</span>;
  }
  if (name === "side") return <span className={`side ${String(value).toLowerCase()}`}>{String(value).toUpperCase()}</span>;
  if (name === "size_wei") {
    const raw = String(value);
    const human = Number(BigInt(raw) / 10n ** 18n) + Number(BigInt(raw) % 10n ** 18n) / 1e18;
    return (<><span className="attr-raw">{raw}</span> <span className="attr-human">({human})</span></>);
  }
  if (name === "trade_ref" && String(value).startsWith("0x")) {
    return <a className="xlink" href={entityUrl(String(value))} target="_blank" rel="noreferrer">{short(String(value))} ↗</a>;
  }
  if (name === "user" || name === "owner") return <span className="attr-mono">{short(String(value))}</span>;
  if (name === "text_hash") return <span className="attr-mono">{short(String(value))}</span>;
  if (name === "tx" && String(value).startsWith("0x")) {
    return <a className="xlink" href={txUrl(String(value))} target="_blank" rel="noreferrer">{short(String(value))} ↗</a>;
  }
  return <span className="attr-str">{String(value)}</span>;
}

// One row, described the way a trader would say it.
function rowInfo(rec, tradeByKey) {
  const a = rec.attrs ?? {};
  const s = (n) => (a[n] == null || a[n] === "" ? "" : String(a[n]));
  const body = String(rec.payloadText ?? "").trim();
  if (rec.kind === "trade_journal") {
    const pnl = Number(a.pnl_bps ?? 0);
    const side = s("side");
    return {
      action: "Trade recorded",
      sub: side ? side[0].toUpperCase() + side.slice(1) : "",
      asset: s("symbol"),
      details: s("size") ? `${s("size")} share${s("size") === "1" ? "" : "s"}` : "",
      result: <span className={pnl >= 0 ? "pos" : "neg"}>{pnl >= 0 ? "+" : ""}{pnl} bps</span>,
    };
  }
  if (rec.kind === "journal_note") {
    const ref = s("trade_ref");
    const trade = ref ? tradeByKey.get(ref) : null;
    const quote = body ? (body.length > 64 ? `"${body.slice(0, 64)}…"` : `"${body}"`) : "annotation";
    return {
      action: "Note added",
      sub: trade ? `on ${trade.attrs?.symbol ?? "trade"}` : "Trade note",
      asset: trade ? String(trade.attrs?.symbol ?? "—") : short(ref || "—"),
      details: quote,
      result: "—",
    };
  }
  if (rec.kind === "loan_memo") {
    const st = s("status");
    const debt = s("debt_minr");
    return {
      action: "Loan update",
      sub: st === "open" ? "Open position" : st === "closed" ? "Closed position" : st || "position",
      asset: s("collateral_symbol"),
      details: debt ? `debt ₹${debt}` : "no debt",
      result: debt && Number(debt) > 0 ? `₹${debt}` : "—",
    };
  }
  if (rec.kind === "lend_event") {
    const op = s("op");
    return {
      action: LEND_OP[op] ?? "Lending action",
      sub: "From Amoy pool",
      asset: s("symbol"),
      details: "",
      result: s("amount") || "—",
    };
  }
  if (rec.kind === "user_profile") {
    return { action: "Profile", sub: "Trader profile", asset: s("handle") || "—", details: "", result: "—" };
  }
  if (rec.kind === "leaderboard_entry") {
    const score = Number(a.score_bps ?? 0);
    return {
      action: "Performance record",
      sub: "Leaderboard",
      asset: `Rank #${s("rank")}`,
      details: `${s("trades")} trades · ${s("wins")} wins`,
      result: <span className={score >= 0 ? "pos" : "neg"}>{score} bps</span>,
    };
  }
  if (rec.kind === "session_snapshot") {
    return { action: "Market snapshot", sub: "Session", asset: s("symbol"), details: "", result: s("price") || "—" };
  }
  return { action: rec.meta.label, sub: "", asset: "—", details: "", result: "—" };
}

function statusInfo(rec, days) {
  if (days != null && days < 0) return { label: "Expired", cls: "bg-expired", title: "Expiry block passed — the node drops it from queries" };
  const st = String(rec.attrs?.status ?? "").toLowerCase();
  if (rec.kind === "loan_memo" && st === "open") return { label: "Active", cls: "bg-active", title: "Loan position is open" };
  const op = String(rec.attrs?.op ?? "").toLowerCase();
  if (rec.kind === "lend_event" && (op === "borrow" || op === "supply")) {
    return { label: "Active", cls: "bg-active", title: "Active lending action" };
  }
  return { label: "Recorded", cls: "bg-active", title: "Stored on Arkiv, expiry block still ahead" };
}

const PAGE_SIZE = 8;

export default function Explorer({ wallet, onToast }) {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const account = wallet?.account ?? "";
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("all");
  const [mineOnly, setMineOnly] = useState(false);
  const [selectedKey, setSelectedKey] = useState(params.get("key") || "");
  const [verified, setVerified] = useState(() => new Set());
  const [detail, setDetail] = useState(null);
  const [verify, setVerify] = useState({ state: "idle", key: null, error: null });
  const [page, setPage] = useState(1);

  const records = useQuery({
    queryKey: ["ex-records"],
    queryFn: fetchAllRecords,
    // 60s: the keyless RPC throttles chatty clients (429). Data paints
    // instantly from localStorage cache anyway, so a longer freshness window
    // costs nothing visible and halves request volume.
    staleTime: 60_000,
    // Paint the last good read instantly; refetch fills the gaps.
    placeholderData: () => loadRecordsCache(),
    // fetchAllRecords already retries per-collection — don't stack a second retry.
    retry: false,
  });

  const all = useMemo(() => records.data?.rows ?? [], [records.data]);
  const tradeByKey = useMemo(() => {
    const m = new Map();
    for (const r of all) if (r.kind === "trade_journal") m.set(r.key, r);
    return m;
  }, [all]);

  const mine = useMemo(() => {
    if (!mineOnly || !account) return all;
    const me = account.toLowerCase();
    return all.filter((r) => String(r.owner).toLowerCase() === me);
  }, [all, mineOnly, account]);

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return mine;
    return mine.filter((r) => {
      const blob = `${r.key} ${r.owner} ${r.kind} ${HUMAN[r.kind]?.label ?? ""} ${Object.values(r.attrs).join(" ")} ${r.payloadText ?? ""}`.toLowerCase();
      return blob.includes(q);
    });
  }, [mine, search]);

  const tabRows = useMemo(() => searched.filter((r) => inTab(r, tab)), [searched, tab]);
  const counts = useMemo(() => ({
    all: searched.length,
    trades: searched.filter((r) => r.kind === "trade_journal").length,
    notes: searched.filter((r) => r.kind === "journal_note").length,
    loans: searched.filter((r) => r.kind === "loan_memo" || r.kind === "lend_event").length,
  }), [searched]);

  // Summary cards — real counts from the trader's own records.
  const summary = useMemo(() => {
    const trades = mine.filter((r) => r.kind === "trade_journal");
    const wins = trades.filter((r) => Number(r.attrs?.pnl_bps ?? 0) > 0).length;
    const losses = trades.filter((r) => Number(r.attrs?.pnl_bps ?? 0) < 0).length;
    const notes = mine.filter((r) => r.kind === "journal_note").length;
    const memos = mine.filter((r) => r.kind === "loan_memo");
    const open = memos.filter((r) => String(r.attrs?.status ?? "").toLowerCase() === "open").length;
    const lends = mine.filter((r) => r.kind === "lend_event");
    const ops = {};
    for (const e of lends) {
      const op = String(e.attrs?.op ?? "");
      ops[op] = (ops[op] ?? 0) + 1;
    }
    const lendSub = lends.length
      ? Object.entries(ops).filter(([, n]) => n > 0).map(([op, n]) => `${n} ${op}${n === 1 ? "" : "s"}`).join(" · ")
      : "No lending actions yet";
    return { trades: trades.length, wins, losses, notes, open, memos: memos.length, lends: lends.length, lendSub };
  }, [mine]);

  const pageCount = Math.max(1, Math.ceil(tabRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = tabRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const from = tabRows.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const to = Math.min(safePage * PAGE_SIZE, tabRows.length);

  const runQuery = () => qc.invalidateQueries({ queryKey: ["ex-records"] });
  const copy = (text, what) => {
    navigator.clipboard?.writeText(text);
    onToast?.({ kind: "ok", msg: what });
  };
  const pick = (rec) => {
    setSelectedKey(rec.key);
    setParams((p) => { const n = new URLSearchParams(p); n.set("key", rec.key); return n; }, { replace: true });
  };

  // "View proof" / "Verify record" — the actual deep fetch from Tiramisu.
  const view = async (rec) => {
    pick(rec);
    setDetail(null);
    setVerify({ state: "checking", key: rec.key, error: null });
    try {
      const fresh = await fetchEntityDirect(rec.key);
      const attrs = {};
      for (const [n, a] of Object.entries(fresh.attributes ?? {})) attrs[n] = a?.value ?? a;
      setDetail({ rec: { ...rec, attrs, owner: fresh.owner }, at: Date.now() });
      setVerified((s) => new Set(s).add(rec.key));
      setVerify({ state: "ok", key: rec.key, error: null });
    } catch (e) {
      setVerify({ state: "error", key: rec.key, error: e.message });
      onToast?.({ kind: "err", msg: `verify failed: ${e.message}` });
    }
  };

  // Keep a record selected: the ?key= deep link, else the newest visible row.
  useEffect(() => {
    if (selectedKey && all.some((r) => r.key === selectedKey)) return;
    const wanted = params.get("key");
    if (wanted && all.some((r) => r.key === wanted)) {
      setSelectedKey(wanted);
      return;
    }
    if (!selectedKey && pageRows.length > 0) pick(pageRows[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, selectedKey, params]);

  const selected = detail?.rec ?? all.find((r) => r.key === selectedKey) ?? null;
  const selectedVerified = selected ? verified.has(selected.key) : false;
  const vstate = selected && verify.key === selected.key ? verify.state : "idle";

  const days = selected
    ? expiresInDays(selected.expiresAtBlock, records.data?.currentBlock, records.data?.blockDuration)
    : null;
  const expiryText = selected
    ? days == null
      ? "Never — permanent record"
      : days < 0
        ? "Expired"
        : `${fmtDaysLabel(days)} · ${fmtDate(Date.now() + days * 86_400_000)}`
    : "";

  const selInfo = selected ? rowInfo(selected, tradeByKey) : null;
  const selHuman = selected ? HUMAN[selected.kind] ?? selected.meta : null;

  const proofFields = (() => {
    if (!selected) return [];
    const a = selected.attrs ?? {};
    const s = (n) => (a[n] == null || a[n] === "" ? "—" : String(a[n]));
    const dt = <>{fmtDate(selected.createdMs)} <i>({timeAgo(selected.createdMs)})</i></>;
    if (selected.kind === "trade_journal") {
      return [
        ["Asset", s("symbol")],
        ["Side", <span className={`side ${String(a.side ?? "").toLowerCase()}`}>{String(a.side ?? "—").toUpperCase()}</span>],
        ["Quantity", s("size") === "—" ? "—" : `${s("size")} shares`],
        ["Entry price", s("price") === "—" ? "—" : `₹${Number(a.price).toLocaleString("en-IN")}`],
        ["Result", <span className={Number(a.pnl_bps ?? 0) >= 0 ? "pos" : "neg"}>{Number(a.pnl_bps ?? 0) >= 0 ? "+" : ""}{s("pnl_bps")} bps</span>],
        ["Date & time", dt],
      ];
    }
    if (selected.kind === "journal_note") {
      const ref = s("trade_ref");
      const trade = ref !== "—" ? tradeByKey.get(ref) : null;
      return [
        ["Your note", String(selected.payloadText ?? "—")],
        ["Linked trade", trade
          ? <>{String(trade.attrs?.symbol ?? "trade")} · <span className={Number(trade.attrs?.pnl_bps ?? 0) >= 0 ? "pos" : "neg"}>{Number(trade.attrs?.pnl_bps ?? 0) >= 0 ? "+" : ""}{String(trade.attrs?.pnl_bps ?? 0)} bps</span></>
          : ref !== "—" ? <a className="xlink" href={entityUrl(ref)} target="_blank" rel="noreferrer">{short(ref)} ↗</a> : "—"],
        ["Written by", short(String(a.user ?? selected.owner))],
        ["Date & time", dt],
      ];
    }
    if (selected.kind === "loan_memo") {
      return [
        ["Collateral", `${s("collateral_symbol")} · ${s("collateral_amount")}`],
        ["Debt", s("debt_minr") === "—" ? "—" : `₹${s("debt_minr")}`],
        ["Health factor", s("health_factor")],
        ["Status", s("status")],
        ["Date & time", dt],
      ];
    }
    if (selected.kind === "lend_event") {
      return [
        ["Action", LEND_OP[String(a.op ?? "")] ?? s("op")],
        ["Asset", s("symbol")],
        ["Amount", s("amount")],
        ["Amoy tx", a.tx ? <a className="xlink" href={txUrl(String(a.tx))} target="_blank" rel="noreferrer">{short(String(a.tx))} ↗</a> : "—"],
        ["Date & time", dt],
      ];
    }
    if (selected.kind === "leaderboard_entry") {
      return [
        ["Rank", `#${s("rank")}`],
        ["Score", `${s("score_bps")} bps`],
        ["Trades", s("trades")],
        ["Wins", s("wins")],
        ["Updated", a.updated_ms ? fmtDate(Number(a.updated_ms)) : "—"],
      ];
    }
    if (selected.kind === "session_snapshot") {
      return [
        ["Symbol", s("symbol")],
        ["Price", s("price")],
        ["Market", a.market_open ? "Open" : "Closed"],
        ["Date & time", dt],
      ];
    }
    if (selected.kind === "user_profile") {
      return [
        ["Handle", s("handle")],
        ["Wallet", short(String(a.user ?? selected.owner))],
        ["Date & time", dt],
      ];
    }
    return [["Date & time", dt]];
  })();

  const sumCard = (icon, tint, label, value, sub) => (
    <div className="sum-card">
      <span className="sum-ico" style={{ background: `${tint}22`, color: tint }}>{icon}</span>
      <div className="sum-txt">
        <i>{label}</i>
        <b>{value}</b>
        <em>{sub}</em>
      </div>
    </div>
  );

  return (
    <div className="page">
      {/* ── header ─────────────────────────────────────────────── */}
      <div className="page-head">
        <div className="ph-icon"><img src="/eqora-mark.svg" alt="" width="40" height="40" /></div>
        <div className="ph-title">
          <h2>Your Records</h2>
          <p>Every trade and lending action, independently verifiable on Arkiv.</p>
        </div>
        <div className="rec-note">
          <span className="rec-note-ico">🛡</span>
          <span>Your trading journal is stored on Arkiv.<br />View and verify your records anytime.</span>
        </div>
      </div>

      {/* ── summary cards ──────────────────────────────────────── */}
      <div className="sum-row">
        {sumCard("📈", "#34d399", "Trade records", summary.trades, summary.trades ? `${summary.wins} wins · ${summary.losses} losses` : "No trades yet")}
        {sumCard("📝", "#f59e0b", "Notes saved", summary.notes, summary.notes ? "Your annotations" : "No notes yet")}
        {sumCard("🏦", "#22d3ee", "Open loans", summary.open, summary.memos ? `${summary.memos} loan update${summary.memos === 1 ? "" : "s"} on file` : "No loan records")}
        {sumCard("🛡", "#8b5cf6", "Verified on Arkiv", verified.size, verified.size ? "Deep-fetched this session" : "Press View proof to verify")}
      </div>

      <div className="rec-layout">
        {/* ── left: record history ─────────────────────────────── */}
        <div className="rec-main">
          <div className="card">
            <div className="rec-toolbar">
              <div className="rec-tabs" role="tablist">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={tab === t.id}
                    className={`rec-tab${tab === t.id ? " on" : ""}`}
                    onClick={() => { setTab(t.id); setPage(1); }}
                  >
                    {t.label} <span>({counts[t.id]})</span>
                  </button>
                ))}
              </div>
              <div className="rec-tools">
                <div className="ex-search">
                  <span>🔍</span>
                  <input
                    type="text"
                    placeholder="Search by asset, type or record key…"
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  />
                </div>
                <button className={`ex-filter${mineOnly ? " on" : ""}`} title="Only records owned by this wallet" onClick={() => { setMineOnly((v) => !v); setPage(1); }}>
                  ⚲ My records
                </button>
                <button className="ex-filter" title="Refetch every collection from Tiramisu" onClick={runQuery}>↻ Run</button>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="rec-table" role="table">
              <div className="rec-head" role="row">
                <span>#</span><span>Action</span><span>Asset / Details</span><span>Result</span><span>Date &amp; Time</span><span>Status</span><span />
              </div>
              {records.isLoading && <div className="empty">Reading your records from Tiramisu…</div>}
              {!records.isLoading && records.isError && (
                <div className="empty">Couldn't reach Tiramisu — press <b>↻ Run</b> to try again.</div>
              )}
              {!records.isLoading && !records.isError && tabRows.length === 0 && (
                <div className="empty">
                  {records.data?.failedKinds?.length
                    ? `Partial read — ${records.data.failedKinds.length} collection(s) timed out on the public RPC. Press ↻ Run.`
                    : search
                      ? "No records match your search."
                      : mineOnly && account
                        ? "No records under this wallet yet — record a trade to fill this page."
                        : "No records on this view — press ↻ Run."}
                </div>
              )}
              {pageRows.map((rec, i) => {
                const info = rowInfo(rec, tradeByKey);
                const st = statusInfo(rec, expiresInDays(rec.expiresAtBlock, records.data?.currentBlock, records.data?.blockDuration));
                const isSel = rec.key === selectedKey;
                return (
                  <div className={`rec-row${isSel ? " sel" : ""}`} key={rec.key} role="row" onClick={() => pick(rec)}>
                    <span className="rec-nr">{(safePage - 1) * PAGE_SIZE + i + 1}</span>
                    <span className="rec-act">
                      <span className="rec-ico" style={{ background: `${rec.meta.tint}22`, color: rec.meta.tint }}>{rec.meta.icon}</span>
                      <span className="rec-cell">
                        <b>{info.action}</b>
                        <i>{info.sub}</i>
                      </span>
                    </span>
                    <span className="rec-cell rec-asset">
                      <b>{info.asset}</b>
                      {info.details ? <i title={info.details}>{info.details}</i> : null}
                    </span>
                    <span className="rec-result">{info.result}</span>
                    <span className="rec-cell rec-date">
                      <b>{rec.createdMs ? new Date(rec.createdMs).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"}</b>
                      <i title={fmtDate(rec.createdMs)}>
                        {rec.createdMs ? new Date(rec.createdMs).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : ""}
                        {rec.createdEst ? " ≈" : ""}
                      </i>
                    </span>
                    <span className={`rec-chip ${st.cls}`} title={st.title}>{st.label}</span>
                    <span>
                      <button
                        className="rec-view"
                        onClick={(e) => { e.stopPropagation(); view(rec); }}
                      >
                        View proof
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="rec-foot">
              <span className="rec-count">
                {tabRows.length
                  ? `Showing ${from}–${to} of ${tabRows.length} record${tabRows.length === 1 ? "" : "s"}`
                  : "0 records"}
                {records.data ? ` · read browser-direct in ${records.data.tookMs}ms` : ""}
              </span>
              {pageCount > 1 && (
                <div className="pager">
                  <button className="pgbtn" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>‹</button>
                  {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                    <button key={n} className={`pgbtn${n === safePage ? " on" : ""}`} onClick={() => setPage(n)}>{n}</button>
                  ))}
                  <button className="pgbtn" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>›</button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── right: record proof ──────────────────────────────── */}
        <div className="rec-side">
          <div className="card rec-proof">
            {!selected ? (
              <div className="empty">Pick a record and press <b>View proof</b> to fetch it from Tiramisu and verify it.</div>
            ) : (
              <>
                <div className="proof-head">
                  <span className="rec-ico lg" style={{ background: `${selected.meta.tint}22`, color: selected.meta.tint }}>{selected.meta.icon}</span>
                  <div className="proof-titles">
                    <h3>{selHuman?.label ?? selected.kind}</h3>
                    <p>
                      {selected.kind === "trade_journal"
                        ? `${selInfo.sub} ${selInfo.details ? `${selInfo.details} ` : ""}${selInfo.asset}`
                        : selInfo.sub || selHuman?.desc}
                    </p>
                  </div>
                  <div className="proof-chips">
                    <span className={`rec-chip ${statusInfo(selected, days).cls}`}>{statusInfo(selected, days).label}</span>
                    {selectedVerified && <span className="bg-verified" title="Fetched from the node and checked this session">✓ Verified on Arkiv</span>}
                  </div>
                </div>

                <div className="proof-fields">
                  {proofFields.map(([k, v]) => (
                    <div className="proof-f" key={k}>
                      <span className="proof-fk">{k}</span>
                      <span className="proof-fv">{v}</span>
                    </div>
                  ))}
                </div>

                <div className="proof-banner">
                  <span>🛡</span>
                  <span>This record is stored on Arkiv and can be verified independently.</span>
                </div>

                {vstate === "error" && (
                  <div className="proof-err-box">
                    Verification failed: {verify.error} — the record may not be indexed yet. Press <b>Verify record</b> to retry.
                  </div>
                )}

                <div className="proof-actions">
                  <button className="det-btn primary" disabled={vstate === "checking"} onClick={() => view(selected)}>
                    {vstate === "checking" ? "Checking the chain…" : vstate === "ok" ? "✓ Verified on Arkiv" : "Verify record"}
                  </button>
                  <a className="det-btn" href={entityUrl(selected.key)} target="_blank" rel="noreferrer">Open in Arkiv Explorer</a>
                  <button className="det-btn" onClick={() => copy(selected.key, "record key copied")}>Copy record key</button>
                </div>

                <div className="proof-meta">
                  <div className="proof-f"><span className="proof-fk">Owner</span><span className="proof-fv mono">{short(selected.owner, 10)}</span></div>
                  <div className="proof-f"><span className="proof-fk">Recorded</span><span className="proof-fv">{fmtDate(selected.createdMs)} <i>({timeAgo(selected.createdMs)})</i></span></div>
                  <div className="proof-f"><span className="proof-fk">Expires</span><span className="proof-fv">{expiryText}</span></div>
                </div>

                <details className="proof-tech">
                  <summary>Proof details (advanced)</summary>
                  <div className="tech-body">
                    <div className="proof-f"><span className="proof-fk">Entity key</span><span className="proof-fv mono">{short(selected.key, 12)} <button className="mini" onClick={() => copy(selected.key, "entity key copied")}>⧉</button></span></div>
                    <div className="proof-f"><span className="proof-fk">Arkiv kind</span><span className="proof-fv mono">{selected.kind}</span></div>
                    <div className="proof-f"><span className="proof-fk">Owner</span><span className="proof-fv mono">{short(selected.owner, 12)} <button className="mini" onClick={() => copy(selected.owner, "owner copied")}>⧉</button></span></div>
                    <div className="proof-f"><span className="proof-fk">Flags</span><span className="proof-fv mono">{selected.flags?.readonly ? "readonly (immutable)" : "none"}</span></div>
                    <div className="proof-f"><span className="proof-fk">Expires at block</span><span className="proof-fv mono">{selected.expiresAtBlock ?? "—"}</span></div>
                    <div className="det-attrs-head">Attributes <span>{Object.keys(selected.attrs).length} fields</span></div>
                    <div className="det-attrs">
                      {Object.entries(selected.attrs).map(([n, v]) => (
                        <div className="det-attr-row" key={n}>
                          <span className="da-name">{n}</span>
                          <span className="da-val">{fmtAttr(n, v)}</span>
                        </div>
                      ))}
                    </div>
                    {selected.payloadText && (
                      <div className="det-payload"><span>payload</span><code>{String(selected.payloadText).slice(0, 300)}</code></div>
                    )}
                  </div>
                </details>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── developer details (collapsed by default) ───────────── */}
      <details className="dev-details">
        <summary>Network &amp; developer details</summary>
        <div className="dev-body">
          <Proof />
        </div>
      </details>
    </div>
  );
}
