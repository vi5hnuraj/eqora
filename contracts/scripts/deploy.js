// EQORA — Polygon Amoy deployment (resumable).
// Run: npx hardhat run scripts/deploy.js --network polygonAmoy
// Requires PRIVATE_KEY in contracts/.env (deployer = Arkiv service wallet).
// Re-runs skip any contract already deployed at the recorded address (verified
// by on-chain code), so a run interrupted by low gas / a spike resumes cheaply.
const fs = require('fs');
const path = require('path');
const { ethers, network } = require('hardhat');

// One state file per network, keyed by hardhat network name — running the
// script on the in-process 'hardhat' network can never clobber Amoy state.
function stateFile() {
  const name = network.name === 'polygonAmoy' ? 'polygonAmoy' : network.name;
  return path.join(__dirname, '..', 'deployments', `${name}.json`);
}
const FILE = stateFile();

function loadState() {
  if (fs.existsSync(FILE)) {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* rebuild */ }
  }
  return { contracts: {}, wired: false };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2) + '\n');
}

async function hasCode(address) {
  if (!address) return false;
  const code = await ethers.provider.getCode(address);
  return code && code !== '0x';
}

async function getOrDeploy(state, key, name, args = []) {
  const existing = state.contracts[key];
  if (await hasCode(existing)) {
    console.log(`${key}: reuse ${existing}`);
    return ethers.getContractAt(name, existing);
  }
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.deployed();
  console.log(`${key}: deploy ${contract.address}`);
  state.contracts[key] = contract.address;
  saveState(state);
  return contract;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`network chainId=${net.chainId} deployer=${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`balance: ${ethers.utils.formatEther(balance)} native`);

  const state = loadState();

  const oracle = await getOrDeploy(state, 'EqoraPriceOracle', 'EqoraPriceOracle');
  const window = await getOrDeploy(state, 'EqoraBorrowWindow', 'EqoraBorrowWindow');
  const gate = await getOrDeploy(state, 'EqoraAssetGate', 'EqoraAssetGate');
  const minr = await getOrDeploy(state, 'EqoraMINR', 'EqoraMINR');

  const reliance = await getOrDeploy(state, 'IND-RELIANCE', 'EqoraStockToken', ['Reliance Industries (Demo)', 'IND-RELIANCE']);
  const tcs = await getOrDeploy(state, 'IND-TCS', 'EqoraStockToken', ['Tata Consultancy Services (Demo)', 'IND-TCS']);
  const nifty = await getOrDeploy(state, 'IND-NIFTY', 'EqoraStockToken', ['NIFTY 50 Index (Demo)', 'IND-NIFTY']);

  const pool = await getOrDeploy(state, 'Pool', 'EqoraPool', [oracle.address, window.address, gate.address, minr.address]);
  const game = await getOrDeploy(state, 'Game', 'EqoraGame', [oracle.address, minr.address]);

  if (!state.wired) {
    console.log('wiring...');
    await (await oracle.setGate(gate.address)).wait();
    await (await gate.setOracle(oracle.address)).wait();
    await (await minr.setMinter(pool.address)).wait();
    await (await pool.listAsset(reliance.address, 'IND-RELIANCE', 7000, 8000)).wait();
    await (await pool.listAsset(tcs.address, 'IND-TCS', 6500, 7500)).wait();
    await (await pool.listAsset(nifty.address, 'IND-NIFTY', 7500, 8500)).wait();
    state.wired = true;
  } else {
    console.log('already wired');
  }

  state.network = net.chainId === 80002 ? 'polygonAmoy' : 'local-hardhat';
  state.chainId = Number(net.chainId);
  state.deployer = deployer.address;
  state.deployedAt = new Date().toISOString();
  state.complete = true;
  saveState(state);

  console.log(`written: ${FILE}`);
  console.log(JSON.stringify(state.contracts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
