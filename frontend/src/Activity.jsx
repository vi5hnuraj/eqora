import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { listJournal, subscribeJournal, createNote, deleteNote, patchNote, claimJournal, listNotes } from "./api.js";
import { exportJournalsCsv, verifyNoteHash, entityUrl, fmtDate, fetchEntityDirect } from "./arkiv.js";
import { browserAccount, signCreateNote, signPatchNote, signDeleteNote } from "./arkivWallet.js";
import { SYMBOLS, CONTRACTS } from "./config.js";
import AssetIcon from "./AssetIcon.jsx";
import RiskList from "./RiskList.jsx";
import Proof from "./Proof.jsx";
import { short, timeAgo } from "./format.js";

const DEFAULT_FILTERS = {
  symbols: [],
  symbolMode: "any",
  outcome: "",
  sessionPrefix: "",
  typeFilter: "",
  excludeSide: false,
  typeofFilter: "",
  expiringSoon: false,
  ownedByMe: false,
  minPnlBps: "",
  maxPnlBps: "",
};

function FilterChip({ active, onClick, children, title }) {
  return (
    <button className={`fchip${active ? " on" : ""}`} title={title} onClick={onClick}>
      {children}{active && <i className="fchip-x">×</i>}
    </button>
  );
}

/* ── the page ─────────────────────────────────────────────────────────── */
export default function Activity({ wallet, refreshKey, onToast }) {
  const { account } = wallet;
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [sideFilter, setSideFilter] = useState("");
  const [timeFilter, setTimeFilter] = useState("");
  const [exporting, setExporting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [live, setLive] = useState(false);
  const [noteBusy, setNoteBusy] = useState(null);
  const [noteDrafts, setNoteDrafts] = useState({});
  const [composing, setComposing] = useState(null);
  const [verifying, setVerifying] = useState(null);
  const [verifyData, setVerifyData] = useState(null);
  const [filters, setFilters] = useState({ ...DEFAULT_FILTERS });
  const [page, setPage] = useState(1);
  const [moreRow, setMoreRow] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const PAGE_SIZE = 10;
  const powerOn = [filters.ownedByMe, filters.expiringSoon, filters.typeofFilter].filter(Boolean).length;
  const filterCount = useMemo(
    () =>
      filters.symbols.length +
      [filters.outcome, filters.sessionPrefix, filters.typeFilter, filters.typeofFilter,
        filters.minPnlBps, filters.maxPnlBps, sideFilter, timeFilter].filter((v) => v !== "").length +
      [filters.ownedByMe, filters.expiringSoon].filter(Boolean).length,
    [filters, sideFilter, timeFilter]
  );
  const resetFilters = () => {
    setFilters({ ...DEFAULT_FILTERS, symbols: [] });
    setSideFilter("");
    setTimeFilter("");
  };
  useEffect(() => { setPage(1); }, [search, sideFilter, timeFilter, filters]);

  const jqParams = useMemo(() => {
    const p = { user: account, limit: 100 };
    if (filters.symbols.length) {
      p.symbols = filters.symbols.join(",");
      if (filters.symbolMode === "all" && filters.symbols.length > 1) p.symbolMode = "all";
    }
    if (filters.outcome) p.outcome = filters.outcome;
    if (filters.sessionPrefix) p.sessionPrefix = filters.sessionPrefix;
    if (filters.typeFilter) p.typeFilter = filters.typeFilter;
    if (filters.excludeSide) p.excludeSide = "buy";
    if (filters.typeofFilter) p.typeofFilter = filters.typeofFilter;
    if (filters.expiringSoon) p.expiringSoon = "1";
    if (filters.ownedByMe && account) p.owner = account;
    if (filters.minPnlBps !== "") p.minPnlBps = filters.minPnlBps;
    if (filters.maxPnlBps !== "") p.maxPnlBps = filters.maxPnlBps;
    return p;
  }, [account, filters]);

  const tradesQ = useQuery({
    queryKey: ["act-trades", account, refreshKey, jqParams],
    queryFn: () => listJournal(jqParams),
    enabled: Boolean(account),
    placeholderData: keepPreviousData,
  });

  // The whole journal, unfiltered — the query box always reports real totals,
  // while the rows below follow the chip filters.
  const baseQ = useQuery({
    queryKey: ["act-base", account, refreshKey],
    queryFn: () => listJournal({ user: account, limit: 100 }),
    enabled: Boolean(account),
    placeholderData: keepPreviousData,
  });

  const notesQ = useQuery({
    queryKey: ["notes", account],
    queryFn: async () => {
      try {
        const res = await listNotes({ user: account });
        return res?.entities ?? [];
      } catch {
        return [];
      }
    },
    enabled: Boolean(account),
  });

  const trades = tradesQ.data?.entities ?? [];
  const baseRows = baseQ.data?.entities ?? [];
  const notes = notesQ.data ?? [];

  const winCount = useMemo(() => {
    return baseRows.filter((r) => Number(r.attributes?.pnl_bps ?? r.pnlBps ?? 0) > 0).length;
  }, [baseRows]);

  // Live rows: invalidate so stats/tables re-read the chain.
  useEffect(() => {
    if (!account) return;
    const stop = subscribeJournal((event) => {
      setLive(true);
      if (event.type === "created" && event.attributes?.kind === "trade_journal") {
        qc.invalidateQueries({ queryKey: ["act-trades", account] });
        qc.invalidateQueries({ queryKey: ["act-base", account] });
      }
      if (event.type === "ownership") {
        qc.invalidateQueries({ queryKey: ["act-trades", account] });
        qc.invalidateQueries({ queryKey: ["act-base", account] });
      }
    }, () => setLive(false));
    return stop;
  }, [account, qc]);

  const stats = useMemo(() => {
    const acct = String(account ?? "").toLowerCase();
    const rows = baseRows.map((t) => ({
      ...t,
      pnl: Number(t.attributes?.pnl_bps ?? 0),
      ms: Number(t.attributes?.created_ms ?? 0),
    }));
    const wins = rows.filter((r) => r.pnl > 0);
    const losses = rows.filter((r) => r.pnl < 0);
    const net = rows.reduce((s, r) => s + r.pnl, 0);
    const best = rows.reduce((b, r) => (r.pnl > (b?.pnl ?? -Infinity) ? r : b), null);
    const avg = rows.length ? Math.round(net / rows.length) : 0;
    const rate = rows.length ? Math.round((wins.length / rows.length) * 1000) / 10 : 0;
    const owned = rows.filter((r) => String(r.owner ?? "").toLowerCase() === acct).length;
    return { rows, wins, losses, net, best, avg, rate, owned };
  }, [baseRows, account]);

  // Table rows: chip-filtered by the server, then search/side/time applied locally.
  const tableRows = useMemo(() => trades.map((t) => ({
    ...t,
    pnl: Number(t.attributes?.pnl_bps ?? 0),
    ms: Number(t.attributes?.created_ms ?? 0),
  })), [trades]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const cutoff = timeFilter === "24h" ? Date.now() - 86_400_000 : timeFilter === "7d" ? Date.now() - 7 * 86_400_000 : timeFilter === "30d" ? Date.now() - 30 * 86_400_000 : 0;
    return tableRows.filter((r) => {
      const sym = String(r.attributes?.symbol ?? "");
      if (sideFilter && String(r.attributes?.side ?? "") !== sideFilter) return false;
      if (cutoff && r.ms < cutoff) return false;
      if (q && !`${sym} ${r.key} ${r.attributes?.session ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tableRows, search, sideFilter, timeFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = filteredRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const notesByTrade = useMemo(() => {
    const map = {};
    for (const n of notes) (map[n.tradeRef] ??= []).push(n);
    return map;
  }, [notes]);

  const runExport = async () => {
    setExporting(true);
    try {
      const csv = await exportJournalsCsv(account);
      const blob = new Blob([csv], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `eqora-journal-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      onToast?.({ kind: "ok", msg: "CSV exported from Arkiv (async iterator)" });
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setExporting(false);
    }
  };

  const toggleSymbol = (sym) =>
    setFilters((f) => ({
      ...f,
      symbols: f.symbols.includes(sym) ? f.symbols.filter((s) => s !== sym) : [...f.symbols, sym],
    }));

  const claimAll = async () => {
    const keys = stats.rows.map((e) => e.key).filter(Boolean);
    if (!keys.length) return;
    setClaiming(true);
    try {
      const result = await claimJournal(keys, account);
      if (result.alreadyOwned) {
        onToast?.({ kind: "ok", msg: `already owned by you (${result.alreadyOwned} entries)` });
      } else {
        onToast?.({ kind: "ok", msg: `claimed ${result.ownershipChanges.length} entries → your wallet (tx ${short(result.txHash)})` });
      }
      await Promise.all([tradesQ.refetch(), baseQ.refetch()]);
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setClaiming(false);
    }
  };

  // Inline annotate compose — text comes from the row's own input (no prompt).
  const signNote = async (tradeKey) => {
    const text = (noteDrafts[tradeKey] ?? "").trim();
    if (!text) return;
    setNoteBusy(tradeKey);
    try {
      try {
        const signer = await browserAccount();
        await signCreateNote({ account: signer, tradeRef: tradeKey, text });
      } catch (walletError) {
        if (/faucet|No wallet/i.test(walletError.message)) throw walletError;
        await createNote({ user: account, tradeRef: tradeKey, text, claim: true });
      }
      onToast?.({ kind: "ok", msg: "note written on Arkiv — bytes32 hash stored" });
      setNoteDrafts((d) => ({ ...d, [tradeKey]: "" }));
      setComposing(null);
      await notesQ.refetch();
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setNoteBusy(null);
    }
  };

  // Browser-direct verify panel — one entity, fetched by the browser (no backend).
  const verify = async (key) => {
    if (verifying === key) { setVerifying(null); setVerifyData(null); return; }
    setVerifying(key);
    setVerifyData(null);
    try {
      setVerifyData(await fetchEntityDirect(key));
    } catch (e) {
      onToast?.({ kind: "err", msg: `verify failed: ${e.message}` });
      setVerifying(null);
    }
  };

  const claimRow = async (key) => {
    setNoteBusy(`claim:${key}`);
    try {
      const r = await claimJournal([key], account);
      onToast?.({ kind: "ok", msg: r.alreadyOwned ? "already yours" : `claimed → ${short(r.txHash)}` });
      await Promise.all([tradesQ.refetch(), baseQ.refetch()]);
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setNoteBusy(null);
    }
  };

  const editNote = async (note) => {
    const next = window.prompt("Edit note (payload + hash republished):", note.text);
    if (next == null || !next.trim() || next === note.text) return;
    setNoteBusy(note.key);
    try {
      try {
        const signer = await browserAccount();
        await signPatchNote({ account: signer, entityKey: note.key, text: next });
      } catch (walletError) {
        if (/faucet|No wallet/i.test(walletError.message)) throw walletError;
        await patchNote(note.key, next);
      }
      onToast?.({ kind: "ok", msg: "note patched on Arkiv" });
      await notesQ.refetch();
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setNoteBusy(null);
    }
  };

  const removeNote = async (note) => {
    if (!window.confirm("Delete this note on Arkiv?")) return;
    setNoteBusy(note.key);
    try {
      try {
        const signer = await browserAccount();
        await signDeleteNote({ account: signer, entityKey: note.key });
      } catch (walletError) {
        if (/faucet|No wallet/i.test(walletError.message)) throw walletError;
        await deleteNote(note.key);
      }
      onToast?.({ kind: "ok", msg: "note deleted on Arkiv" });
      await notesQ.refetch();
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setNoteBusy(null);
    }
  };

  if (!account) {
    return (
      <div className="page">
        <div className="card"><div className="card-body">
          <div className="empty">Connect your wallet to see your practice trades, notes and performance.</div>
        </div></div>
      </div>
    );
  }

  return (
    <div className="page">
      {/* header */}
      <div className="page-head plain">
        <div className="ph-title">
          <h2>Activity &amp; Journal</h2>
          <p>Your practice trades, notes and performance — recorded immutably on Arkiv.</p>
        </div>
        <div className="ph-badge">
          <span className="ph-badge-ico">📒</span>
          <span>Every trade. Every note.<br /><b>Unfakeable on Arkiv.</b></span>
        </div>
      </div>

      <div className="act-grid">
        {/* left column */}
        <div className="act-main">
          <div className="card ex-card">
            <div className="card-head ex-card-head">
              <div className="ex-head-txt"><h2>📚 Trade journal</h2><p>Every record is immutable on Arkiv.</p></div>
              <div className="head-actions">
                <span className="live"><span className="pulse" />{live ? "live" : "stream"}</span>
                <a className="ex-filter btn-volt" href="/trade" style={{ textDecoration: "none" }}>＋ Record a trade</a>
                <button className="ex-filter" disabled={exporting} onClick={runExport}>⇩ {exporting ? "Exporting…" : "Export CSV"}</button>
              </div>
            </div>
            <div className="card-body">
              {/* Advanced filters */}
              <div className="fpanel2">
                <div className="fp2-head">
                  <span className="fp2-title">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18l-7 8v6l-4 2v-8z" /></svg>
                    Filters
                    {filterCount > 0 && <em className="fp2-badge">{filterCount}</em>}
                  </span>
                  {filterCount > 0 && (
                    <button className="qreset" onClick={resetFilters}>↺ Reset</button>
                  )}
                </div>

                <div className="fp2-grid">
                  <div className="fp2-row fp2-symbols">
                    <div className="fp2-symhead">
                      <span className="fp2-label">Symbols</span>
                      <div className="fp2-seg">
                        <button className={filters.symbolMode !== "all" ? "on" : ""} onClick={() => setFilters({ ...filters, symbolMode: "any" })}>Any</button>
                        <button className={filters.symbolMode === "all" ? "on" : ""} onClick={() => setFilters({ ...filters, symbolMode: "all" })}>All</button>
                      </div>
                    </div>
                    <div className="fchips">
                      {SYMBOLS.map((s) => (
                        <FilterChip key={s} active={filters.symbols.includes(s)} onClick={() => toggleSymbol(s)}>{s.replace("IND-", "")}</FilterChip>
                      ))}
                    </div>
                  </div>

                  <div className="fp2-row">
                    <span className="fp2-label">Result</span>
                    <div className="fp2-seg">
                      <button className={filters.outcome === "" ? "on" : ""} onClick={() => setFilters({ ...filters, outcome: "" })}>All</button>
                      <button className={filters.outcome === "win" ? "on" : ""} onClick={() => setFilters({ ...filters, outcome: "win" })}>Wins</button>
                      <button className={filters.outcome === "loss" ? "on" : ""} onClick={() => setFilters({ ...filters, outcome: "loss" })}>Losses</button>
                    </div>
                  </div>

                  <div className="fp2-row">
                    <span className="fp2-label">Trade type</span>
                    <div className="fp2-seg">
                      <button className={filters.typeFilter === "" ? "on" : ""} onClick={() => setFilters({ ...filters, typeFilter: "" })}>All</button>
                      <button className={filters.typeFilter === "spot" ? "on" : ""} onClick={() => setFilters({ ...filters, typeFilter: "spot" })}>Spot</button>
                      <button className={filters.typeFilter === "leverage" ? "on" : ""} onClick={() => setFilters({ ...filters, typeFilter: "leverage" })}>Leverage</button>
                    </div>
                  </div>

                  <div className="fp2-row">
                    <span className="fp2-label">Side</span>
                    <div className="fp2-seg">
                      <button className={sideFilter === "" ? "on" : ""} onClick={() => setSideFilter("")}>All</button>
                      <button className={sideFilter === "buy" ? "on" : ""} onClick={() => setSideFilter("buy")}>Buy</button>
                      <button className={sideFilter === "sell" ? "on" : ""} onClick={() => setSideFilter("sell")}>Sell</button>
                    </div>
                  </div>

                  <div className="fp2-row">
                    <span className="fp2-label">Period</span>
                    <div className="fp2-seg">
                      <button className={timeFilter === "" ? "on" : ""} onClick={() => setTimeFilter("")}>All</button>
                      <button className={timeFilter === "24h" ? "on" : ""} onClick={() => setTimeFilter("24h")}>24h</button>
                      <button className={timeFilter === "7d" ? "on" : ""} onClick={() => setTimeFilter("7d")}>7d</button>
                      <button className={timeFilter === "30d" ? "on" : ""} onClick={() => setTimeFilter("30d")}>30d</button>
                    </div>
                  </div>

                  <div className="fp2-row">
                    <span className="fp2-label">Session</span>
                    <input className="finput" type="text" placeholder="e.g. t-1a2" value={filters.sessionPrefix}
                      onChange={(e) => setFilters({ ...filters, sessionPrefix: e.target.value })} />
                  </div>

                  <div className="fp2-row">
                    <span className="fp2-label">PnL (bps)</span>
                    <div className="frange">
                      <input className="finput" type="number" placeholder="min" value={filters.minPnlBps}
                        onChange={(e) => setFilters({ ...filters, minPnlBps: e.target.value })} />
                      <input className="finput" type="number" placeholder="max" value={filters.maxPnlBps}
                        onChange={(e) => setFilters({ ...filters, maxPnlBps: e.target.value })} />
                    </div>
                  </div>
                </div>

                <button className="fp2-more" onClick={() => setMoreOpen(!moreOpen)}>
                  <span>{moreOpen ? "▾" : "▸"}</span> Power filters
                  {powerOn > 0 && <em>{powerOn} on</em>}
                </button>
                {moreOpen && (
                  <div className="fchips fp2-power">
                    <FilterChip active={filters.ownedByMe} onClick={() => setFilters({ ...filters, ownedByMe: !filters.ownedByMe })}>Only my entities</FilterChip>
                    <FilterChip active={filters.expiringSoon} onClick={() => setFilters({ ...filters, expiringSoon: !filters.expiringSoon })}>Expiring ≤ 7d</FilterChip>
                    <FilterChip active={filters.typeofFilter === "size_wei:u256"} onClick={() => setFilters({ ...filters, typeofFilter: filters.typeofFilter ? "" : "size_wei:u256" })}>u256 sizes</FilterChip>
                  </div>
                )}

                <div className="qstrip">
                  <code title="live Arkiv query for the current filters">{tradesQ.data?.query || "—"}</code>
                  <span className="qstat"><b>{trades.length}</b> matched</span>
                  <span className="qstat"><b>{filteredRows.length}</b> shown</span>
                  <span className="qstat"><b>{stats.rows.length}</b> total</span>
                  {winCount != null && (
                    <span className="qstat"><b>{winCount}</b> wins</span>
                  )}
                  <div className="qstrip-acts">
                    <button className="sm primary" onClick={() => tradesQ.refetch()} disabled={tradesQ.isFetching}>
                      {tradesQ.isFetching ? "…" : "↻ Run"}
                    </button>
                    <button className="sm" disabled={claiming} onClick={claimAll}>{claiming ? "…" : "Claim all"}</button>
                  </div>
                </div>
                {(tradesQ.data?.nodeFallbacks ?? []).length > 0 && (
                  <div className="qfb">node gaps: {tradesQ.data.nodeFallbacks.join(", ")}</div>
                )}
              </div>

              <div className="ex-toolbar">
                <div className="ex-search">
                  <span>🔍</span>
                  <input type="text" placeholder="Search trades (e.g. RELIANCE, TCS…)" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <div className="pager">
                  <button className="pgbtn" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>‹</button>
                  {Array.from({ length: pageCount }, (_, i) => i + 1).slice(0, 5).map((n) => (
                    <button key={n} className={`pgbtn${n === safePage ? " on" : ""}`} onClick={() => setPage(n)}>{n}</button>
                  ))}
                  <button className="pgbtn" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>›</button>
                </div>
              </div>

              <div className="trow thead">
                <span></span>
                <span></span>
                <span>Size</span>
                <span>Entry price (₹)</span>
                <span>P&amp;L</span>
                <span>Recorded on Arkiv</span>
                <span></span>
              </div>

              <div className="list">
                {tradesQ.isLoading && <div className="empty">Reading your journal from Tiramisu…</div>}
                {!tradesQ.isLoading && filteredRows.length === 0 && (
                  <div className="empty">No trades match — record one on the <a className="xlink" href="/trade">Trade page →</a></div>
                )}
                {pageRows.map((e) => {
                  const a = e.attributes ?? {};
                  const linked = notesByTrade[e.key ?? ""] ?? [];
                  const owned = String(e.owner ?? "").toLowerCase() === String(account ?? "").toLowerCase();
                  const fl = e.creationFlags ?? e.flags;
                  return (
                    <div className={`entry-wrap${verifying === e.key ? " open" : ""}`} key={e.key}>
                      <div className="entry trow">
                        <span className={`side ${String(a.side ?? "")}`}>{String(a.side ?? "?").toUpperCase()}</span>
                        <div className="tid">
                          <div className="l1">
                            <AssetIcon sym={String(a.symbol ?? "")} size={20} />
                            {a.symbol}
                            {a.trade_type === "leverage"
                              ? <span className="pill lev">{a.leverage}x</span>
                              : <span className="pill">spot</span>}
                          </div>
                          <div className="l2">
                            {fl?.readonly && <span className="pill">readonly</span>}
                            {fl?.permissionlessExtension && <span className="pill perm">pe</span>}
                            <a className="xlink" href={entityUrl(e.key)} target="_blank" rel="noreferrer" title="Open entity on the Tiramisu explorer">{short(e.key)} ↗</a>
                            <span>{e.createdEst ? "≈ " : ""}{e.ms ? `${fmtDate(e.ms)} · ` : ""}{timeAgo(e.ms)}</span>
                          </div>
                        </div>
                        <span className="tcol sz">{String(a.size ?? "—")}</span>
                        <span className="tcol px">₹{Number(a.price ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                        <span className={`pnl ${e.pnl >= 0 ? "pos" : "neg"}`}>{e.pnl >= 0 ? "+" : ""}{e.pnl} bps</span>
                        <span className="tcol rec">{e.ms ? (e.createdEst ? "≈ " : "") + fmtDate(e.ms) : "—"}</span>
                        <div className="tacts">
                          <button className="mini act" onClick={() => verify(e.key)}>
                            {verifying === e.key ? "▲ Hide" : "🛡 Verify"}
                          </button>
                          <button className="mini act" onClick={() => { setComposing(e.key); setTimeout(() => document.getElementById(`note-${e.key}`)?.focus(), 0); }}>
                            🗎 Add note{linked.length ? ` (${linked.length})` : ""}
                          </button>
                          <button className="mini act dots" onClick={() => setMoreRow(moreRow === e.key ? null : e.key)}>⋯</button>
                        </div>
                      </div>

                      {moreRow === e.key && (
                        <div className="rowmore">
                          <button className="mini" title="Copy entity key" onClick={() => { navigator.clipboard?.writeText(e.key); onToast?.({ kind: "ok", msg: "key copied" }); }}>⧉ Copy key</button>
                          <a className="mini rowmore-link" href={entityUrl(e.key)} target="_blank" rel="noreferrer">↗ Explorer</a>
                          {owned ? (
                            <span className="creator-inline">owned ✓</span>
                          ) : (
                            <button className="mini claim" disabled={noteBusy === `claim:${e.key}`} onClick={() => claimRow(e.key)}>
                              {noteBusy === `claim:${e.key}` ? "…" : "Claim entity"}
                            </button>
                          )}
                        </div>
                      )}

                      {verifying === e.key && (
                        <div className="verify">
                          {verifyData ? (
                            <>
                              <div className="vrow"><span>key</span><code>{verifyData.key}</code></div>
                              <div className="vrow"><span>owner</span><code>{verifyData.owner}</code></div>
                              <div className="vrow"><span>creator</span><code>{verifyData.creator}</code></div>
                              <div className="vrow"><span>expires at block</span><code>{String(verifyData.expiresAt)}</code>
                                <a className="xlink" href={entityUrl(e.key)} target="_blank" rel="noreferrer">explorer</a></div>
                              <div className="vrow"><span>flags</span>
                                <code>readonly={String(Boolean(fl?.readonly))} permExt={String(Boolean(fl?.permissionlessExtension))}</code></div>
                              <div className="vrow"><span>attrs</span>
                                <code>{Object.keys(verifyData.attributes ?? {}).length} attrs · {verifyData.payload ? "payload ✓" : "no payload"}</code></div>
                              <div className="vnote">fetched directly from Tiramisu by your browser — no backend involved</div>
                            </>
                          ) : (
                            <div className="vnote">fetching entity from Arkiv…</div>
                          )}
                        </div>
                      )}

                      <div className="notes">
                        {linked.map((note) => {
                          const hashOk = verifyNoteHash(note.textHash, note.text);
                          return (
                            <div className="note-row" key={note.key}>
                              <span className={`hashdot${hashOk ? " ok" : ""}`} title={hashOk ? "keccak256(payload) matches bytes32 attr" : "hash mismatch"}>
                                {hashOk ? "◆" : "◇"}
                              </span>
                              <span className="note-text">{note.text}</span>
                              <span className="note-right">
                                <span className="note-meta">
                                  {hashOk ? "hash ✓" : "hash ?"} · {short(note.key)}
                                  <a className="xlink" href={entityUrl(note.key)} target="_blank" rel="noreferrer">↗</a>
                                </span>
                                <span className="hist-actions">
                                  <button className="mini" disabled={noteBusy === note.key} onClick={() => editNote(note)}>edit</button>
                                  <button className="mini danger" disabled={noteBusy === note.key} onClick={() => removeNote(note)}>del</button>
                                </span>
                              </span>
                            </div>
                          );
                        })}
                        {(composing === e.key || Boolean((noteDrafts[e.key] ?? "").trim())) && (
                          <div className="note-compose">
                            <input
                              id={`note-${e.key}`}
                              type="text"
                              placeholder="annotate this trade — signed by your wallet (key → trade, keccak256 hash)"
                              value={noteDrafts[e.key] ?? ""}
                              onChange={(ev) => setNoteDrafts((d) => ({ ...d, [e.key]: ev.target.value }))}
                              onKeyDown={(ev) => { if (ev.key === "Enter") signNote(e.key); }}
                            />
                            <button className="sm" disabled={noteBusy === e.key || !(noteDrafts[e.key] ?? "").trim()} onClick={() => signNote(e.key)}>
                              {noteBusy === e.key ? "…" : "Sign"}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      <RiskList wallet={wallet} onToast={onToast} />

      {/* contract addresses — deployed money-math (Polygon Amoy) */}
      <div className="ex-foot">
        <div className="about-card">
          <h3>Contract addresses (Polygon Amoy)</h3>
          <div className="contract-list">
            {Object.entries(CONTRACTS).filter(([k]) => k !== "tokens").map(([k, v]) => (
              <div className="contract-item" key={k}>
                <span className="k">{k}</span>
                <span className="v">
                  {v}
                  <button className="mini cpy" title="Copy address" onClick={() => { navigator.clipboard?.writeText(v); onToast?.({ kind: "ok", msg: `${k} copied` }); }}>⧉</button>
                </span>
              </div>
            ))}
            {Object.entries(CONTRACTS.tokens).map(([sym, addr]) => (
              <div className="contract-item" key={sym}>
                <span className="k">{sym}</span>
                <span className="v">
                  {addr}
                  <button className="mini cpy" title="Copy address" onClick={() => { navigator.clipboard?.writeText(addr); onToast?.({ kind: "ok", msg: `${sym} copied` }); }}>⧉</button>
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Build on Tiramisu — live proof, kept at the very bottom */}
        <Proof />
      </div>
    </div>
  );
}
