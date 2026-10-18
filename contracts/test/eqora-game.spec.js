const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');

const E8 = (n) => ethers.utils.parseUnits(n.toString(), 8);
const E18 = (n) => ethers.utils.parseUnits(n.toString(), 18);
const FEE = 30; // bps, must match EqoraGame default

async function deploy(name, args = []) {
  const contract = await (await ethers.getContractFactory(name)).deploy(...args);
  await contract.deployed();
  return contract;
}

async function fixture() {
  const [deployer, user, stranger] = await ethers.getSigners();

  const oracle = await deploy('EqoraPriceOracle');
  const minr = await deploy('EqoraMINR');
  const reliance = await deploy('EqoraStockToken', ['Reliance Industries (Demo)', 'IND-RELIANCE']);
  const tcs = await deploy('EqoraStockToken', ['Tata Consultancy Services (Demo)', 'IND-TCS']);
  const game = await deploy('EqoraGame', [oracle.address, minr.address]);

  await game.listStock(reliance.address, 'IND-RELIANCE');
  await game.listStock(tcs.address, 'IND-TCS');

  // venue inventory: 100 RELIANCE shares + 100 TCS shares
  await reliance.mint(game.address, E18(100));
  await tcs.mint(game.address, E18(100));
  // venue mINR reserve: 5,00,000 demo rupees
  await minr.mint(game.address, E18(500000));

  await oracle.setPrice('IND-RELIANCE', E8(2850));
  await oracle.setPrice('IND-TCS', E8(4120));

  // trader wallet: demo rupees from the public faucet
  await minr.connect(user).faucet();

  return { deployer, user, stranger, oracle, minr, reliance, tcs, game };
}

describe('EqoraGame (spot venue)', function () {
  it('quotes a buy at the oracle price with the 0.30% fee included', async function () {
    const f = await loadFixture(fixture);
    // 2850 INR buys exactly 1 share pre-fee; post-fee = 0.997 share
    const [shares, price] = await f.game.quoteBuy(f.reliance.address, E18(2850));
    expect(price).to.equal(E8(2850));
    expect(shares).to.be.closeTo(E18(0.997), E18(0.000001));

    const [minrOut] = await f.game.quoteSell(f.reliance.address, E18(1));
    expect(minrOut).to.be.closeTo(E18(2841.45), E18(0.0001)); // 2850 * 0.997
  });

  it('buys shares with one wallet confirmation: mINR in, stock out', async function () {
    const f = await loadFixture(fixture);
    const [shares] = await f.game.quoteBuy(f.tcs.address, E18(4120));

    await f.minr.connect(f.user).approve(f.game.address, E18(4120));
    await expect(f.game.connect(f.user).buyStock(f.tcs.address, E18(4120), shares))
      .to.emit(f.game, 'StockBought');

    expect(await f.tcs.balanceOf(f.user.address)).to.be.closeTo(E18(0.997), E18(0.000001));
    expect(await f.minr.balanceOf(f.game.address)).to.equal(E18(500000 + 4120));
    expect(await f.game.inventoryOf(f.tcs.address)).to.be.closeTo(E18(99.003), E18(0.000001));
  });

  it('sells shares back to the venue for mINR', async function () {
    const f = await loadFixture(fixture);
    const [shares] = await f.game.quoteBuy(f.reliance.address, E18(2850));
    await f.minr.connect(f.user).approve(f.game.address, E18(2850));
    await f.game.connect(f.user).buyStock(f.reliance.address, E18(2850), shares);

    const [expected] = await f.game.quoteSell(f.reliance.address, shares);
    await f.reliance.connect(f.user).approve(f.game.address, shares);
    const before = await f.minr.balanceOf(f.user.address);
    await expect(f.game.connect(f.user).sellStock(f.reliance.address, shares, expected))
      .to.emit(f.game, 'StockSold');

    expect((await f.minr.balanceOf(f.user.address)).sub(before)).to.be.closeTo(expected, E18(0.000001));
    // round trip: 0.30% fee each way on 2850 (8.55 + 8.52) -> 9982.93 left of 10,000
    expect(await f.minr.balanceOf(f.user.address)).to.be.closeTo(E18(9982.93), E18(0.01));
  });

  it('enforces the reviewed minimum output (slippage)', async function () {
    const f = await loadFixture(fixture);
    const [shares] = await f.game.quoteBuy(f.reliance.address, E18(2850));
    await f.minr.connect(f.user).approve(f.game.address, E18(2850));

    await expect(
      f.game.connect(f.user).buyStock(f.reliance.address, E18(2850), shares.mul(2))
    ).to.be.revertedWith('slippage');

    // a dust amount rounds to zero shares
    await expect(
      f.game.connect(f.user).buyStock(f.reliance.address, 1, 0)
    ).to.be.revertedWith('amount too small');
  });

  it('refuses to trade against a stale oracle push', async function () {
    const f = await loadFixture(fixture);
    await time.increase(7 * 3600); // beyond the 6h maxQuoteAge
    await expect(f.game.quoteBuy(f.reliance.address, E18(2850))).to.be.revertedWith('stale price');

    // owner can widen the tolerance (delayed market data is the premise)
    await f.game.setMaxQuoteAge(8 * 3600);
    await expect(f.game.quoteBuy(f.reliance.address, E18(2850))).to.not.be.reverted;
  });

  it('fails loudly when the venue runs out of inventory or reserve', async function () {
    const f = await loadFixture(fixture);
    // inventory: buy half the venue's RELIANCE, then ask for more than is left
    const [shares] = await f.game.quoteBuy(f.reliance.address, E18(2850));
    await f.minr.connect(f.user).approve(f.game.address, E18(2850 * 150));
    await f.game.connect(f.user).buyStock(f.reliance.address, E18(2850), shares);

    await f.minr.mint(f.user.address, E18(1000000)); // owner tops the trader up
    await expect(
      f.game.connect(f.user).buyStock(f.reliance.address, E18(2850 * 150), 1)
    ).to.be.revertedWith('no inventory');

    // reserve: drain it, then try to sell the shares we hold
    const reserve = await f.game.reserveBalance();
    await f.game.withdrawMinr(f.deployer.address, reserve);
    await f.reliance.connect(f.user).approve(f.game.address, shares);
    await expect(
      f.game.connect(f.user).sellStock(f.reliance.address, shares, 1)
    ).to.be.revertedWith('no reserve');
  });

  it('only the owner lists stocks, sets fees and withdraws treasury', async function () {
    const f = await loadFixture(fixture);
    await expect(
      f.game.connect(f.stranger).listStock(f.stranger.address, 'IND-X')
    ).to.be.revertedWith('Ownable: caller is not the owner');
    await expect(f.game.connect(f.stranger).setFee(0)).to.be.revertedWith('Ownable: caller is not the owner');
    await expect(f.game.connect(f.stranger).withdrawMinr(f.stranger.address, 1))
      .to.be.revertedWith('Ownable: caller is not the owner');
    await expect(f.game.setFee(501)).to.be.revertedWith('fee too high');
  });

  it('blocks trading while paused', async function () {
    const f = await loadFixture(fixture);
    await f.game.setPaused(true);
    await f.minr.connect(f.user).approve(f.game.address, E18(2850));
    await expect(
      f.game.connect(f.user).buyStock(f.reliance.address, E18(2850), 1)
    ).to.be.revertedWith('paused');
  });

  it('rejects unlisted stocks', async function () {
    const f = await loadFixture(fixture);
    await expect(f.game.quoteBuy(f.stranger.address, E18(1))).to.be.revertedWith('not listed');
  });
});
