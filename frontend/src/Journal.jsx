import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SYMBOLS } from "./config.js";
import {
  listJournal,
  createJournal,
  subscribeJournal,
  claimJournal,
  createNote,
  patchNote,
  deleteNote,
} from "./api.js";
import {
  exportJournalsCsv,
  fetchEntityDirect,
  fetchNotesDirect,
  fetchWinCountDirect,
  entityUrl,
  verifyNoteHash,
} from "./arkiv.js";
import {
  browserAccount,
  signCreateNote,
  signDeleteNote,
  signPatchNote,
} from "./arkivWallet.js";
import { short, timeAgo } from "./format.js";

const OUTCOMES = [
  ["", "all pnl"],
  ["win", "wins > 0"],
  ["loss", "losses < 0"],
];

const TYPES = [
  ["", "spot + leverage"],
  ["spot", "spot only"],
  ["leverage", "leverage only"],
];

function FilterChip({ active, onClick, children, title }) {
  return (
    <button className={`fchip${active ? " on" : ""}`} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

export default function Journal({ wallet, onToast }) {
  const { account } = wallet;
  const [entries, setEntries] = useState([]);
  const [query, setQuery] = useState("");
  const [nodeFallbacks, setNodeFallbacks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(false);
  const [filters, setFilters] = useState({
    symbols: [],
    outcome: "",
    sessionPrefix: "",
    typeFilter: "",
    excludeSide: false,
    typeofFilter: "",
    expiringSoon: false,
    ownedByMe: false,
    minPnlBps: "",
    maxPnlBps: "",
  });
  const [form, setForm] = useState({ symbol: SYMBOLS[0], side: "buy", size: "1", price: "1200", pnlBps: "100", note: "" });
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(null);
  const [verifyData, setVerifyData] = useState(null);
  const [noteDrafts, setNoteDrafts] = useState({});
  const [noteBusy, setNoteBusy] = useState(null);
  const [exporting, setExporting] = useState(false);
  const session = useRef(`s-${Date.now().toString(36)}`);
  const qc = useQueryClient();

  const params = useMemo(() => {
    const p = { user: account, limit: 100 };
    if (filters.symbols.length) p.symbols = filters.symbols.join(",");
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

  const load = useCallback(async () => {
    if (!account) { setEntries([]); return; }
    setLoading(true);
    try {
      const page = await listJournal(params);
      setEntries(page.entities);
      setQuery(page.query ?? "");
      setNodeFallbacks(page.nodeFallbacks ?? []);
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setLoading(false);
    }
  }, [account, params, onToast]);

  useEffect(() => { load(); }, [load]);

  // Browser-direct read: every note the trader owns, grouped per trade.
  const notesQuery = useQuery({
    queryKey: ["notes", account],
    queryFn: () => fetchNotesDirect(account),
    enabled: Boolean(account),
    staleTime: 10_000,
  });
  const notesByTrade = useMemo(() => {
    const map = {};
    for (const note of notesQuery.data ?? []) {
      (map[note.tradeRef] ??= []).push(note);
    }
    return map;
  }, [notesQuery.data]);

  // Browser-direct gt() query — win count without the backend.
  const winsQuery = useQuery({
    queryKey: ["win-count", account],
    queryFn: () => fetchWinCountDirect(account),
    enabled: Boolean(account),
    staleTime: 15_000,
  });

  // Live stream: a new immutable journal row appears the moment it is written.
  useEffect(() => {
    if (!account) return;
    const stop = subscribeJournal(
      (event) => {
        setLive(true);
        if (event.type === "created" && event.attributes?.kind === "trade_journal") {
          setEntries((prev) => {
            const key = event.entityKey;
            if (prev.some((e) => e.key === key)) return prev;
            return [{ live: true, key, attributes: event.attributes, createdAt: event.at }, ...prev];
          });
        }
        if (event.type === "ownership") {
          qc.invalidateQueries({ queryKey: ["owned", account] });
        }
      },
      () => setLive(false)
    );
    return stop;
  }, [account, qc]);

  const record = async () => {
    setBusy(true);
    try {
      await createJournal({
        user: account,
        symbol: form.symbol,
        side: form.side,
        size: form.size,
        price: form.price,
        pnlBps: Number(form.pnlBps),
        session: session.current,
        note: form.note,
      });
      onToast?.({ kind: "ok", msg: "journal entry written — immutable on Arkiv" });
      await load();
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setBusy(false);
    }
  };

  const claim = async () => {
    const keys = entries.map((e) => e.key).filter(Boolean);
    if (!keys.length) return;
    setBusy(true);
    try {
      const result = await claimJournal(keys, account);
      if (result.alreadyOwned) {
        onToast?.({ kind: "ok", msg: `already owned by you (${result.alreadyOwned} entries)` });
      } else {
        onToast?.({ kind: "ok", msg: `claimed ${result.ownershipChanges.length} entries → your wallet (tx ${short(result.txHash)})` });
      }
      await load();
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setBusy(false);
    }
  };

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
      onToast?.({ kind: "ok", msg: "CSV exported from a direct Arkiv walk (async iterator)" });
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setExporting(false);
    }
  };

  // Verify on Arkiv: fetch the raw entity straight from the browser.
  const verify = async (key) => {
    if (verifying === key) { setVerifying(null); setVerifyData(null); return; }
    setVerifying(key);
    setVerifyData(null);
    try {
      const entity = await fetchEntityDirect(key);
      setVerifyData({
        key: entity.key,
        owner: entity.owner,
        creator: entity.creator,
        createdAt: Number(entity.createdAt),
        expiresAt: Number(entity.expiresAt),
        flags: entity.creationFlags ?? null,
        attrs: Object.keys(entity.attributes ?? {}).length,
        contentType: entity.contentType,
      });
    } catch (e) {
      onToast?.({ kind: "err", msg: `verify failed: ${e.message}` });
      setVerifying(null);
    }
  };

  // Notes: try the user's own wallet first (browser-signed), fall back to
  // the service wallet when MetaMask/GLM isn't available.
  const addNote = async (tradeKey) => {
    const text = String(noteDrafts[tradeKey] ?? "").trim();
    if (!text) return;
    setNoteBusy(tradeKey);
    try {
      let signed = null;
      try {
        const signer = await browserAccount();
        signed = await signCreateNote({ account: signer, tradeRef: tradeKey, text });
      } catch (walletError) {
        if (/faucet|No wallet/i.test(walletError.message)) throw walletError;
        signed = await createNote({ user: account, tradeRef: tradeKey, text, claim: true });
      }
      setNoteDrafts((d) => ({ ...d, [tradeKey]: "" }));
      onToast?.({
        kind: "ok",
        msg: `note ${signed.txHash ? "signed" : "written"} on Arkiv — bytes32 hash stored`,
      });
      await notesQuery.refetch();
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setNoteBusy(null);
    }
  };

  const editNote = async (note, tradeKey) => {
    const next = window.prompt("Edit note (payload + bytes32 hash republished):", note.text);
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
      await notesQuery.refetch();
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
      onToast?.({ kind: "ok", msg: "note deleted — entity gone from Arkiv" });
      await notesQuery.refetch();
    } catch (e) {
      onToast?.({ kind: "err", msg: e.message });
    } finally {
      setNoteBusy(null);
    }
  };

  const toggleSymbol = (sym) =>
    setFilters((f) => ({
      ...f,
      symbols: f.symbols.includes(sym) ? f.symbols.filter((s) => s !== sym) : [...f.symbols, sym],
    }));

  if (!account) {
    return (
      <div className="card">
        <div className="card-head"><h2>Trade journal</h2></div>
        <div className="card-body"><div className="empty">Connect to record trades and query your unfakeable track record.</div></div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Trade journal</h2>
        <span className="live"><span className="pulse" />{live ? "live" : "stream"}</span>
      </div>
      <div className="card-body">
        <div className="field">
          <label>Record a closed trade (written to Arkiv, immutable)</label>
          <div className="seg" style={{ marginBottom: 8 }}>
            <button className={form.side === "buy" ? "active" : ""} onClick={() => setForm({ ...form, side: "buy" })}>BUY</button>
            <button className={form.side === "sell" ? "active" : ""} onClick={() => setForm({ ...form, side: "sell" })}>SELL</button>
            <select value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })}
              style={{ flex: 1, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--line-2)", borderRadius: 9, padding: "9px 10px", fontFamily: "var(--mono)" }}>
              {SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="row" style={{ marginBottom: 8 }}>
            <input type="number" step="any" placeholder="size" value={form.size} onChange={(e) => setForm({ ...form, size: e.target.value })} />
            <input type="number" step="any" placeholder="price ₹" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            <input type="number" step="1" placeholder="P&L bps" value={form.pnlBps} onChange={(e) => setForm({ ...form, pnlBps: e.target.value })} />
          </div>
          <input type="text" placeholder="note (stored in payload)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} style={{ marginBottom: 8 }} />
          <button className="primary" disabled={busy} onClick={record} style={{ width: "100%" }}>
            {busy ? "Writing…" : "Record trade on Arkiv"}
          </button>
        </div>

        <div className="divider" />

        <div className="fbar">
          <div className="fgroup">
            <span className="flabel">symbol (or)</span>
            <div className="fchips">
              {SYMBOLS.map((s) => (
                <FilterChip key={s} active={filters.symbols.includes(s)} onClick={() => toggleSymbol(s)}>{s.replace("IND-", "")}</FilterChip>
              ))}
            </div>
          </div>
          <div className="fgroup">
            <span className="flabel">outcome (gt/lt)</span>
            <div className="fchips">
              {OUTCOMES.map(([v, label]) => (
                <FilterChip key={v || "all"} active={filters.outcome === v} onClick={() => setFilters({ ...filters, outcome: v })}>{label}</FilterChip>
              ))}
            </div>
          </div>
          <div className="fgroup">
            <span className="flabel">type (exists/not)</span>
            <div className="fchips">
              {TYPES.map(([v, label]) => (
                <FilterChip key={v || "all"} active={filters.typeFilter === v} onClick={() => setFilters({ ...filters, typeFilter: v })}>{label}</FilterChip>
              ))}
            </div>
          </div>
          <div className="fgroup">
            <span className="flabel">predicates</span>
            <div className="fchips">
              <FilterChip active={filters.excludeSide} onClick={() => setFilters({ ...filters, excludeSide: !filters.excludeSide })} title="side != buy (falls back to NOT side = buy on this node)">sells only (ne)</FilterChip>
              <FilterChip active={filters.ownedByMe} onClick={() => setFilters({ ...filters, ownedByMe: !filters.ownedByMe })} title="Restricts to entities your wallet owns">ownedBy(me)</FilterChip>
              <FilterChip active={filters.expiringSoon} onClick={() => setFilters({ ...filters, expiringSoon: !filters.expiringSoon })} title="$expiresAt within 7 days of the current Tiramisu block">expiring ≤7d ($expiresAt)</FilterChip>
              <FilterChip active={filters.typeofFilter === "size_wei:u256"} onClick={() => setFilters({ ...filters, typeofFilter: filters.typeofFilter ? "" : "size_wei:u256" })} title="TYPEOF(size_wei) = u256 (falls back to size_wei > u256(0))">schema: u256 sizes</FilterChip>
            </div>
          </div>
          <div className="fgroup fgroup-grow">
            <span className="flabel">session prefix (startswith)</span>
            <input className="finput" type="text" placeholder="e.g. t-1a2" value={filters.sessionPrefix}
              onChange={(e) => setFilters({ ...filters, sessionPrefix: e.target.value })} />
          </div>
          <div className="fgroup">
            <span className="flabel">pnl range (gte/lte)</span>
            <div className="frange">
              <input className="finput" type="number" placeholder="min" value={filters.minPnlBps}
                onChange={(e) => setFilters({ ...filters, minPnlBps: e.target.value })} />
              <input className="finput" type="number" placeholder="max" value={filters.maxPnlBps}
                onChange={(e) => setFilters({ ...filters, maxPnlBps: e.target.value })} />
            </div>
          </div>
          <div className="factions">
            <button className="sm" onClick={load} disabled={loading}>{loading ? "…" : "Query"}</button>
            <button className="sm" onClick={runExport} disabled={exporting} title="Walk every page with the SDK async iterator, right in the browser">{exporting ? "…" : "Export CSV"}</button>
            <button className="sm" onClick={claim} disabled={busy}>Claim all</button>
          </div>
        </div>

        <div className="qbox" title="render() of the exact expression the node parsed">
          <span className="qtag">arkiv_query</span>
          <code>{query || "—"}</code>
          <div className="qmeta">
            <span>rows: {entries.length}</span>
            {winsQuery.data != null && <span>wins (browser gt()): {winsQuery.data}</span>}
            {nodeFallbacks.length > 0 && (
              <span className="qfb">node gaps: {nodeFallbacks.join(", ")}</span>
            )}
          </div>
        </div>

        <div className="list">
          {entries.length === 0 && <div className="empty">{loading ? "Querying Arkiv…" : "No trades match — record one above or widen filters."}</div>}
          {entries.map((e) => {
            const a = e.attributes || {};
            const pnl = Number(a.pnl_bps ?? 0);
            const notes = notesByTrade[e.key ?? ""] ?? [];
            const owned = String(e.owner ?? "").toLowerCase() === String(account).toLowerCase();
            return (
              <div className={`entry-wrap${verifying === e.key ? " open" : ""}`} key={e.key}>
                <div className="entry">
                  <span className={`side ${a.side}`}>{(a.side || "?").toUpperCase()}</span>
                  <div className="body">
                    <div className="l1">{a.symbol} <span className="sz">{a.size} @ ₹{a.price}</span>
                      {a.trade_type === "leverage" && <span className="pill lev">{a.leverage}x</span>}
                      {a.trade_type === "spot" && <span className="pill">spot</span>}
                    </div>
                    <div className="l2">
                      {e.flags?.readonly && <span className="pill">readonly</span>}
                      {e.flags?.permissionlessExtension && <span className="pill perm">pe</span>}
                      <a className="xlink" href={entityUrl(e.key)} target="_blank" rel="noreferrer"
                        title="Open entity on the Tiramisu explorer">{short(e.key)} ↗</a>
                      <span>{a.created_ms ? timeAgo(Number(a.created_ms)) : (e.live ? timeAgo(e.createdAt) : "just now")}</span>
                      <button className="mini" onClick={() => verify(e.key)}>
                        {verifying === e.key ? "hide" : "verify"}
                      </button>
                      <button className="mini" onClick={() => document.getElementById(`note-${e.key}`)?.focus()}>
                        note{notes.length ? ` (${notes.length})` : ""}
                      </button>
                    </div>
                  </div>
                  <div>
                    <div className={`pnl ${pnl >= 0 ? "pos" : "neg"}`}>{pnl >= 0 ? "+" : ""}{pnl} bps</div>
                    <div className="creator">
                      {owned ? "owned ✓" : <button className="mini claim" onClick={claim}>claim</button>}
                    </div>
                  </div>
                </div>

                {verifying === e.key && (
                  <div className="verify">
                    {verifyData ? (
                      <>
                        <div className="vrow"><span>key</span><code>{verifyData.key}</code></div>
                        <div className="vrow"><span>owner</span><code>{verifyData.owner}</code></div>
                        <div className="vrow"><span>creator</span><code>{verifyData.creator}</code></div>
                        <div className="vrow"><span>expires at block</span><code>{verifyData.expiresAt}</code>
                          <a className="xlink" href={entityUrl(e.key)} target="_blank" rel="noreferrer">explorer</a></div>
                        <div className="vrow"><span>flags</span>
                          <code>readonly={String(verifyData.flags?.readonly)} permExt={String(verifyData.flags?.permissionlessExtension)}</code></div>
                        <div className="vrow"><span>attrs / content</span><code>{verifyData.attrs} · {verifyData.contentType}</code></div>
                        <div className="vnote">fetched directly from Tiramisu by your browser — no backend involved</div>
                      </>
                    ) : (
                      <div className="vnote">fetching entity from Arkiv…</div>
                    )}
                  </div>
                )}

                <div className="notes">
                  {notes.map((note) => {
                    const hashOk = verifyNoteHash(note.textHash, note.text);
                    return (
                      <div className="note-row" key={note.key}>
                        <span className={`hashdot${hashOk ? " ok" : ""}`} title={hashOk ? "keccak256(payload) matches bytes32 attr" : "hash mismatch"}>
                          {hashOk ? "◆" : "◇"}
                        </span>
                        <span className="note-text">{note.text}</span>
                        <span className="note-meta">
                          {hashOk ? "hash ✓" : "hash ?"} · {short(note.owner)}
                          <a className="xlink" href={entityUrl(note.key)} target="_blank" rel="noreferrer">↗</a>
                        </span>
                        <button className="mini" disabled={noteBusy === note.key} onClick={() => editNote(note, e.key)}>edit</button>
                        <button className="mini danger" disabled={noteBusy === note.key} onClick={() => removeNote(note)}>del</button>
                      </div>
                    );
                  })}
                  <div className="note-compose">
                    <input
                      id={`note-${e.key}`}
                      type="text"
                      placeholder="annotate this trade — signed by your wallet (key → trade, keccak256 hash)"
                      value={noteDrafts[e.key] ?? ""}
                      onChange={(ev) => setNoteDrafts((d) => ({ ...d, [e.key]: ev.target.value }))}
                      onKeyDown={(ev) => { if (ev.key === "Enter") addNote(e.key); }}
                    />
                    <button className="sm" disabled={noteBusy === e.key || !(noteDrafts[e.key] ?? "").trim()}
                      onClick={() => addNote(e.key)}>
                      {noteBusy === e.key ? "…" : "Sign"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
