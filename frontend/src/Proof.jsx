import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  TIRAMISU_RPC, TIRAMISU_WS, EXPLORER,
  fetchArkivStatus, probeHttp, probeWs, addressUrl,
} from "./arkiv.js";
import { getArkivStatus } from "./api.js";
import { short } from "./format.js";

const DOCS = "https://docs.arkiv.network";
const HUB = "https://hub.arkiv.network";
const EXPECTED_CHAIN = 7738577;

/* Build on Tiramisu — every value read from the network right now. */
export default function Proof() {
  const chain = useQuery({ queryKey: ["proof-chain"], queryFn: fetchArkivStatus, refetchInterval: 30_000, retry: 1 });
  const srv = useQuery({ queryKey: ["proof-srv"], queryFn: getArkivStatus, refetchInterval: 30_000, retry: 1 });
  const [httpMs, setHttpMs] = useState(null);
  const [ws, setWs] = useState(null);

  // Fresh browser-direct probes each time the card mounts.
  useEffect(() => {
    let alive = true;
    probeHttp().then((ms) => alive && setHttpMs(ms)).catch(() => alive && setHttpMs(-1));
    probeWs().then((r) => alive && setWs(r)).catch(() => alive && setWs({ ok: false, ms: -1 }));
    return () => { alive = false; };
  }, []);

  const c = chain.data;
  const s = srv.data;
  const chainOk = c?.chainId === EXPECTED_CHAIN;
  const err = chain.isError && srv.isError;

  const row = (k, v, cls) => (
    <div className={`proof-row${cls ? ` ${cls}` : ""}`} key={k}>
      <span className="proof-k">{k}</span>
      <span className="proof-v">{v}</span>
    </div>
  );

  return (
    <div className="card ex-card proof">
      <div className="card-head ex-card-head">
        <div className="ex-head-txt">
          <h2>⛓ Built on Tiramisu</h2>
          <p>Live proof — every value below is read from the network right now.</p>
        </div>
        <span className={`live${err ? " err" : ""}`}><span className="pulse" />{err ? "offline" : "live"}</span>
      </div>
      <div className="card-body">
        <div className={`status-chip${err ? " err" : ""}`}>
          <span className="dot" />
          <span>chain {c?.chainId ?? "…"}</span>
          <span>block #{c ? c.currentBlock.toLocaleString("en-IN") : "…"}</span>
          <span>{c ? `${c.blockDuration}s blocks` : "… blocks"}</span>
          <span>{c ? c.entityCount.toLocaleString("en-IN") : "…"} entities</span>
          <span>accessKey {s?.accessKey ? "✓" : "…"}</span>
          <span>
            transport{" "}
            <b className={s?.transport === "fallback" ? "proof-err" : "proof-ok"}>
              {s?.transport === "fallback" ? "public RPC (key quota hit)" : s?.transport === "key" ? "keyed RPC ✓" : "public RPC"}
            </b>
          </span>
          <span className="status-note">read browser-direct</span>
        </div>

        <div className="proof-rows">
          {row("network", <>
            Tiramisu testnet · chain {EXPECTED_CHAIN}
            {chainOk ? <b className="proof-ok">chainId ✓</b> : c ? <b className="proof-err">chainId ≠ {EXPECTED_CHAIN}</b> : <i>…</i>}
          </>)}
          {row("http rpc", <>
            <a className="xlink" href={TIRAMISU_RPC} target="_blank" rel="noreferrer">{TIRAMISU_RPC} ↗</a>
            <b className="proof-ok">{httpMs == null ? "probing…" : httpMs < 0 ? "unreachable" : `${httpMs}ms ✓`}</b>
          </>)}
          {row("ws rpc", <>
            <span className="proof-url">{TIRAMISU_WS}</span>
            {ws == null ? <i>probing…</i>
              : ws.ok ? <b className="proof-ok">connected ✓ {ws.ms}ms</b>
              : <b className="proof-err">unreachable ✗</b>}
          </>)}
          {row("explorer", <>
            <a className="xlink" href={EXPLORER} target="_blank" rel="noreferrer">tiramisu.explorer.arkiv.network ↗</a>
            {s?.serviceWallet && (
              <a className="xlink" href={addressUrl(s.serviceWallet)} target="_blank" rel="noreferrer" title="service wallet on the explorer">
                {short(s.serviceWallet)} ↗
              </a>
            )}
            {s && <b className="proof-ok">GLM {s.glmBalance}</b>}
          </>)}
          {row("sdk", <>
            <span className="proof-url">{s?.sdk ?? "@arkiv-network/sdk 0.8.x"}</span>
            {s?.sdk && <b className="proof-ok">installed ✓</b>}
          </>)}
          {row("docs", <a className="xlink" href={DOCS} target="_blank" rel="noreferrer">docs.arkiv.network ↗</a>)}
          {row("hub", <a className="xlink" href={HUB} target="_blank" rel="noreferrer">hub.arkiv.network ↗</a>)}
        </div>
      </div>
    </div>
  );
}
