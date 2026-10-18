import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { short } from "./format.js";
import { useCurrency } from "./currency.jsx";

export default function Nav({ wallet, marketOpen }) {
  const [walletOpen, setWalletOpen] = useState(false);
  const walletRef = useRef(null);
  const { pathname } = useLocation();
  const { currency, toggle, usdInr } = useCurrency();

  useEffect(() => {
    const onClick = (e) => {
      if (walletRef.current && !walletRef.current.contains(e.target)) setWalletOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const active = (prefix) => (prefix === "/" ? pathname === "/" : pathname.startsWith(prefix));

  return (
    <div className="nav">
      <Link to="/trade" className="nav-brand" style={{ textDecoration: "none", color: "inherit" }}>
        <div className="logo"><img src="/eqora-mark.svg" alt="" width="34" height="34" /></div>
        <h1>EQORA</h1>
      </Link>

      <div className="nav-links">
        <Link className={`nav-link ${active("/trade") ? "active" : ""}`} to="/trade">
          Trade <span className="beta">Beta</span>
        </Link>
        <Link className={`nav-link ${active("/lend") ? "active" : ""}`} to="/lend">
          Lend
        </Link>
        <Link className={`nav-link ${active("/portfolio") ? "active" : ""}`} to="/portfolio">
          Portfolio
        </Link>

        <Link className={`nav-link ${active("/activity") ? "active" : ""}`} to="/activity">
          Activity
        </Link>
        <Link className={`nav-link ${active("/explorer") ? "active" : ""}`} to="/explorer">
          Explorer
        </Link>
      </div>

      <div className="nav-right">
        <button
          className="badge cur-toggle"
          onClick={toggle}
          title={`Display currency: ${currency}${usdInr ? ` · 1 USD = ₹${usdInr.toFixed(2)}` : ""} (settlement stays in INR/mINR)`}
        >
          {currency === "USD" ? "$ USD" : "₹ INR"} ▾
        </button>
        <span className={`badge ${marketOpen ? "open" : "closed"}`}>
          <span className="dot" /> NSE {marketOpen ? "OPEN" : "CLOSED"}
        </span>
        {wallet.account ? (
          <>
            {!wallet.chainOk && (
              <button className="red" onClick={wallet.switchChain}>Switch to Amoy</button>
            )}
            <div className="nav-dropdown" ref={walletRef}>
              <button
                className={`badge ok mono wallet-chip ${walletOpen ? "on" : ""}`}
                onClick={() => setWalletOpen((o) => !o)}
                title={wallet.account}
              >
                {short(wallet.account)} ▾
              </button>
              {walletOpen && (
                <div className="nav-dropdown-menu wallet-menu">
                  <div className="wallet-menu-head mono">{wallet.account}</div>
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(wallet.account);
                      setWalletOpen(false);
                    }}
                  >
                    Copy address
                  </button>
                  <button
                    onClick={() => {
                      window.open(
                        `https://amoy.polygonscan.com/address/${wallet.account}`,
                        "_blank"
                      );
                      setWalletOpen(false);
                    }}
                  >
                    View on AmoyScan ↗
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      wallet.disconnect?.();
                      setWalletOpen(false);
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <button className="primary" onClick={wallet.connect} disabled={wallet.connecting}>
            {wallet.connecting ? "Connecting…" : wallet.hasWallet ? "Connect Wallet" : "Install MetaMask"}
          </button>
        )}
      </div>
    </div>
  );
}
