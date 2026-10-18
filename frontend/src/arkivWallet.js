// Browser-signed Arkiv writes — MetaMask (or any injected wallet) signs on
// Tiramisu directly; the backend never sees these keys. Writes need GLM gas
// (hub.arkiv.network/faucet); reads above need none.
import { ExpirationTime, createWalletClient, jsonToPayload, stringToPayload } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { addr, bytes32, key, str, u64 } from "@arkiv-network/sdk/attr";
import { custom } from "viem";
import { arkivPublic, hashNote } from "./arkiv.js";

const FAUCET_URL = "https://hub.arkiv.network";

const YEAR_END = (() => {
  const now = new Date();
  return new Date(now.getFullYear(), 11, 31, 23, 59, 59);
})();

const EXPIRY = {
  journal_note: ExpirationTime.atDate(YEAR_END, { atLeast: ExpirationTime.fromDays(30) }),
  user_profile: ExpirationTime.permanent(),
};

function injected() {
  const eth = window.ethereum;
  if (!eth) throw new Error("No wallet found — install MetaMask to sign on Arkiv");
  return eth;
}

function chainHex() {
  return `0x${tiramisu.id.toString(16)}`;
}

// Switch the injected wallet to Tiramisu, adding the chain if unknown.
export async function ensureTiramisu() {
  const eth = injected();
  const current = await eth.request({ method: "eth_chainId" });
  if (Number(current) === tiramisu.id) return;
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainHex() }],
    });
  } catch (error) {
    if (error?.code === 4902 || error?.data?.originalError?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainHex(),
            chainName: tiramisu.name,
            nativeCurrency: tiramisu.nativeCurrency,
            rpcUrls: [tiramisu.rpcUrls.default.http[0]],
            blockExplorerUrls: tiramisu.blockExplorers ? [tiramisu.blockExplorers.default.url] : [],
          },
        ],
      });
    } else {
      throw error;
    }
  }
}

export async function browserAccount() {
  const eth = injected();
  await ensureTiramisu();
  const accounts = await eth.request({ method: "eth_requestAccounts" });
  const account = accounts?.[0];
  if (!account) throw new Error("Wallet returned no account");
  return account;
}

export async function browserWallet() {
  const account = await browserAccount();
  return createWalletClient({
    chain: tiramisu,
    transport: custom(injected()),
    account,
  });
}

// GLM is Tiramisu's native gas token — zero balance means the write will
// fail in MetaMask. Fail early with a faucet link instead.
export async function assertGas(account) {
  const balance = await arkivPublic.getBalance({ address: account });
  if (balance === 0n) {
    throw new Error(`No GLM for gas — claim test tokens at ${FAUCET_URL} (Faucet)`);
  }
  return balance;
}

export async function signCreateNote({ account, tradeRef, text }) {
  const body = String(text ?? "").slice(0, 500);
  if (!body.trim()) throw new Error("note text required");
  await assertGas(account);
  const wallet = await browserWallet();
  const { entityKey, txHash, expiresAt } = await wallet.createEntity({
    payload: stringToPayload(body),
    contentType: "text/plain",
    attributes: {
      kind: str("journal_note"),
      user: addr(account),
      trade_ref: key(tradeRef),
      text_hash: bytes32(hashNote(body)),
      created_ms: u64(BigInt(Date.now())),
    },
    expires: EXPIRY.journal_note,
  });
  return { entityKey, txHash, expiresAt: Number(expiresAt), signer: account };
}

export async function signPatchNote({ account, entityKey, text }) {
  const body = String(text ?? "").slice(0, 500);
  if (!body.trim()) throw new Error("note text required");
  await assertGas(account);
  const wallet = await browserWallet();
  const { txHash } = await wallet.patchEntity({
    entityKey,
    payload: stringToPayload(body),
    contentType: "text/plain",
    set: { text_hash: bytes32(hashNote(body)) },
  });
  return { entityKey, txHash };
}

export async function signDeleteNote({ account, entityKey }) {
  await assertGas(account);
  const wallet = await browserWallet();
  const { txHash } = await wallet.deleteEntity({ entityKey });
  return { entityKey, txHash, deleted: true };
}

// Profile created already owned by the signer, permanent() expiry — it never
// expires and the app cannot touch it.
export async function signCreateProfile({ account, handle }) {
  const name = String(handle ?? "").trim().slice(0, 24);
  if (!name) throw new Error("handle required");
  await assertGas(account);
  const wallet = await browserWallet();
  const { entityKey, txHash } = await wallet.createEntity({
    payload: jsonToPayload({ handle: name, signedBy: account }),
    contentType: "application/json",
    attributes: {
      kind: str("user_profile"),
      user: addr(account),
      handle: str(name),
      created_ms: u64(BigInt(Date.now())),
    },
    expires: EXPIRY.user_profile,
  });
  return { entityKey, txHash, handle: name };
}

export async function signPatchProfile({ account, entityKey, handle }) {
  const name = String(handle ?? "").trim().slice(0, 24);
  if (!name) throw new Error("handle required");
  await assertGas(account);
  const wallet = await browserWallet();
  const { txHash } = await wallet.patchEntity({ entityKey, set: { handle: str(name) } });
  return { entityKey, txHash, handle: name };
}

// Anyone can extend a permissionless-extension journal — including the
// trader, from the browser, keeping their record alive without the app.
export async function signExtend({ account, entityKey, days = 90 }) {
  await assertGas(account);
  const wallet = await browserWallet();
  const { txHash, expiresAt } = await wallet.extendEntity({
    entityKey,
    expires: ExpirationTime.fromDays(days),
  });
  return { entityKey, txHash, expiresAt: Number(expiresAt) };
}

// Direct verify: read one entity back in the browser after a write.
export const verifyOnArkiv = (entityKey) => arkivPublic.getEntity(entityKey);
