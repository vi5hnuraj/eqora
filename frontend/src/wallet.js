import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { AMOY, CONTRACTS } from "./config.js";
import { ORACLE_ABI, WINDOW_ABI, GATE_ABI, POOL_ABI, TOKEN_ABI, MINR_ABI, GAME_ABI } from "./abis.js";

// Amoy's suggested gas spikes 10-15x between idle and send. Cap EIP-1559 fees
// so the fee shown in MetaMask stays bounded and predictable. The old legacy
// `gasPrice` path broke on the public RPC (eth_fillTransaction reverts).
// Amoy's current minimum priority tip is 25 gwei — anything lower gets
// "gas price below minimum" rejections. 60 gwei ceiling keeps spot trades ~0.005 POL.
const MAX_FEE_CAP = 60_000_000_000n; // 60 gwei ceiling
const MIN_PRIORITY = 25_000_000_000n; // 25 gwei — Amoy's enforced minimum tip

async function boundedFees(publicClient) {
  try {
    const fee = await publicClient.estimateFeesPerGas();
    let maxFee = fee.maxFeePerGas;
    let maxPriority = fee.maxPriorityFeePerGas;
    if (maxFee > MAX_FEE_CAP) maxFee = MAX_FEE_CAP;
    if (maxPriority < MIN_PRIORITY) maxPriority = MIN_PRIORITY;
    if (maxPriority > maxFee) maxFee = maxPriority; // maxFee must cover tip
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPriority };
  } catch {
    return { maxFeePerGas: MAX_FEE_CAP, maxPriorityFeePerGas: MIN_PRIORITY };
  }
}

// Walk a viem error chain looking for the contract revert reason (e.g.
// "Stale price") so failures surface before we ever send, not as a fake
// success after. Returns null for transport/RPC errors that aren't reverts.
function revertReason(err) {
  let e = err;
  for (let i = 0; e && i < 8; i++, e = e.cause) {
    if (e.name === "ContractFunctionRevertedError") {
      return e.reason || e.data?.errorName || e.shortMessage || "contract reverted";
    }
    if (typeof e.reason === "string" && e.reason) return e.reason;
  }
  if (err?.name === "ContractFunctionRevertError" || /reverted/i.test(err?.shortMessage || "")) {
    return err.shortMessage;
  }
  return null;
}

export function useWallet() {
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [connecting, setConnecting] = useState(false);

  const publicClient = useMemo(
    () => createPublicClient({ chain: AMOY, transport: http(AMOY.rpcUrls.default.http[0]) }),
    []
  );

  const walletClient = useMemo(() => {
    if (!account || !window.ethereum) return null;
    return createWalletClient({ chain: AMOY, transport: custom(window.ethereum), account });
  }, [account]);

  const read = useCallback(
    ({ address, abi, functionName, args = [] }) =>
      publicClient.readContract({ address, abi, functionName, args }),
    [publicClient]
  );

  const switchChain = useCallback(async () => {
    if (!window.ethereum) return;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + AMOY.id.toString(16) }],
      });
    } catch (err) {
      if (err.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x" + AMOY.id.toString(16),
            chainName: AMOY.name,
            nativeCurrency: AMOY.nativeCurrency,
            rpcUrls: AMOY.rpcUrls.default.http,
            blockExplorerUrls: [AMOY.blockExplorers.default.url],
          }],
        });
      }
    }
  }, []);

  const write = useCallback(
    async ({ address, abi, functionName, args = [] }) => {
      if (!walletClient) throw new Error("Connect wallet first");
      // MetaMask broadcasts on whatever network is currently selected, even if
      // the app's cached chainId says Amoy. Re-check and force-switch right
      // before every tx so confirmations can't land on the wrong chain.
      if (window.ethereum) {
        const cid = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
        if (cid !== AMOY.id) {
          setChainId(cid);
          await switchChain();
          const after = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
          if (after !== AMOY.id) {
            throw new Error(`Wrong network (chain ${after}) — switch MetaMask to Polygon Amoy and retry`);
          }
        }
      }
      const fees = await boundedFees(publicClient);
      // Pre-estimate gas on our Amoy RPC so MetaMask doesn't have to. When
      // MetaMask can't estimate (wrong chain / slow RPC) it shows "--" and
      // greys out Confirm. Passing an explicit gas limit skips its estimation.
      let gas;
      try {
        gas = await publicClient.estimateContractGas({
          address, abi, functionName, args, account: walletClient.account,
        });
        gas = (gas * 115n) / 100n; // 15% buffer (was 50% — MetaMask adds its own on top, so keep this tight)
        if (gas > 300_000n) gas = 300_000n; // hard cap: spot buy/sell never needs more than this on Amoy
      } catch (err) {
        // estimateContractGas reverts when the call WOULD revert (stale
        // price, insufficient collateral, window closed). Surface that
        // reason now instead of broadcasting a tx that will fail.
        const reason = revertReason(err);
        if (reason) throw new Error(reason);
        gas = 180_000n; // RPC hiccup, not a revert — tight fallback gas
      }
      const hash = await walletClient.writeContract({
        address, abi, functionName, args,
        gas,
        ...fees,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      // A mined-but-reverted tx is NOT a success — fail loudly with the hash.
      if (receipt.status !== "success") {
        throw new Error(`Transaction reverted on-chain — ${hash}`);
      }
      return hash;
    },
    [walletClient, publicClient, switchChain]
  );

  // EIP-191 personal_sign — opens the external wallet's sign popup.
  // No gas, no chain switch needed; used to sign leverage tickets before
  // they are written to Arkiv.
  const signMessage = useCallback(
    async (message) => {
      if (!walletClient) throw new Error("Connect wallet first");
      return walletClient.signMessage({ account: walletClient.account, message });
    },
    [walletClient]
  );

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      window.open("https://metamask.io/download/", "_blank");
      return;
    }
    setConnecting(true);
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(accounts[0]);
      const cid = await window.ethereum.request({ method: "eth_chainId" });
      setChainId(parseInt(cid, 16));
      if (parseInt(cid, 16) !== AMOY.id) await switchChain();
    } finally {
      setConnecting(false);
    }
  }, [switchChain]);

  // MetaMask has no plain "disconnect" method — revoke the site's eth_accounts
  // permission (so it stops auto-reconnecting) and clear local state.
  const disconnect = useCallback(async () => {
    try {
      await window.ethereum?.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch { /* older wallets: fall through to local clear */ }
    setAccount(null);
  }, []);

  useEffect(() => {
    if (!window.ethereum) return;
    const onAccounts = (accs) => setAccount(accs[0] ?? null);
    const onChain = (cid) => setChainId(parseInt(cid, 16));
    window.ethereum.on?.("accountsChanged", onAccounts);
    window.ethereum.on?.("chainChanged", onChain);
    window.ethereum.request({ method: "eth_accounts" }).then((a) => a[0] && setAccount(a[0]));
    window.ethereum.request({ method: "eth_chainId" }).then((c) => setChainId(parseInt(c, 16)));
    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAccounts);
      window.ethereum.removeListener?.("chainChanged", onChain);
    };
  }, []);

  // Contract handles for the app.
  const contracts = useMemo(() => {
    const reader = (address, abi) => ({ address, abi, read: (fn, args) => read({ address, abi, functionName: fn, args }) });
    const writer = (address, abi) => ({ address, abi, write: (fn, args) => write({ address, abi, functionName: fn, args }) });
    return {
      pool: { ...reader(CONTRACTS.pool, POOL_ABI), ...writer(CONTRACTS.pool, POOL_ABI) },
      minr: { ...reader(CONTRACTS.minr, MINR_ABI), ...writer(CONTRACTS.minr, MINR_ABI) },
      oracle: reader(CONTRACTS.oracle, ORACLE_ABI),
      window: reader(CONTRACTS.window, WINDOW_ABI),
      gate: reader(CONTRACTS.gate, GATE_ABI),
      game: CONTRACTS.game
        ? { ...reader(CONTRACTS.game, GAME_ABI), ...writer(CONTRACTS.game, GAME_ABI) }
        : null,
      token: (addr) => ({ ...reader(addr, TOKEN_ABI), ...writer(addr, TOKEN_ABI) }),
    };
  }, [read, write]);

  return {
    account, chainId, connecting, connect, disconnect, switchChain, signMessage,
    chainOk: chainId === AMOY.id,
    publicClient, walletClient, read, write, contracts,
    hasWallet: typeof window !== "undefined" && !!window.ethereum,
  };
}
