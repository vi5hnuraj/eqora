// EQORA — list the watchlist on the spot venue and fund it (resumable).
// Run: npx hardhat run scripts/fund-game.js --network polygonAmoy
//
// For every IND-* token in deployments/polygonAmoy.json:
//   1) list it on the EqoraGame (skips if already listed)
//   2) mint venue inventory so buys can fill   (skips tokens already stocked)
//   3) top the mINR reserve up to target       (single cumulative top-up)
// Re-runs are cheap: each step is guarded by an on-chain read, so an
// interrupted run (low gas / RPC spike) resumes where it stopped.
const fs = require('fs');
const path = require('path');
const { ethers, network } = require('hardhat');

const FILE = path.join(
  __dirname, '..', 'deployments',
  `${network.name === 'polygonAmoy' ? 'polygonAmoy' : network.name}.json`
);

// Venue sizing: enough inventory for a demo day of practice trades.
const INVENTORY_PER_STOCK = ethers.utils.parseUnits(process.env.GAME_INVENTORY || '500', 18);
const RESERVE_TARGET = ethers.utils.parseUnits(process.env.GAME_RESERVE || '5000000', 18); // 50,00,000 mINR

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`chainId=${net.chainId} deployer=${deployer.address}`);

  const state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const gameAddr = state.contracts.Game;
  if (!gameAddr) throw new Error('Game not deployed — run scripts/deploy.js first');
  const game = await ethers.getContractAt('EqoraGame', gameAddr);

  const symbols = Object.keys(state.contracts).filter((k) => k.startsWith('IND-'));
  console.log(`venue ${gameAddr} · ${symbols.length} instruments`);

  let txCount = 0;

  for (const symbol of symbols) {
    const tokenAddr = state.contracts[symbol];
    const token = await ethers.getContractAt('EqoraStockToken', tokenAddr);

    // 1) list on the venue
    if (!(await game.isListed(tokenAddr))) {
      const listTx = await game.listStock(tokenAddr, symbol);
      await listTx.wait();
      txCount++;
      console.log(`${symbol}: listed on game`);
    }

    // 2) mint inventory up to target (we are the token owner)
    const held = await game.inventoryOf(tokenAddr);
    if (held.lt(INVENTORY_PER_STOCK)) {
      const need = INVENTORY_PER_STOCK.sub(held);
      const mintTx = await token.mint(gameAddr, need);
      await mintTx.wait();
      txCount++;
      console.log(`${symbol}: +${ethers.utils.formatUnits(need, 18)} shares of inventory`);
    }
  }

  // 3) mINR reserve up to target (owner mint — minter is the pool)
  const reserve = await game.reserveBalance();
  if (reserve.lt(RESERVE_TARGET)) {
    const need = RESERVE_TARGET.sub(reserve);
    const minr = await ethers.getContractAt('EqoraMINR', state.contracts['EqoraMINR'] || state.contracts.EqoraMINR);
    const mintTx = await minr.mint(gameAddr, need);
    await mintTx.wait();
    txCount++;
    console.log(`reserve: +${ethers.utils.formatUnits(need, 18)} mINR`);
  }

  console.log(`---`);
  console.log(`inventory: ${symbols.length} stocks · reserve ${ethers.utils.formatUnits(await game.reserveBalance(), 18)} mINR`);
  console.log(`${txCount} transactions sent in this run`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
