const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');

const E8 = (n) => ethers.utils.parseUnits(n.toString(), 8);
const E18 = (n) => ethers.utils.parseUnits(n.toString(), 18);

// Fixed timestamps (all in the future relative to hardhat genesis, all IST-checked):
// Wed 2026-10-21 10:00 IST  -> market OPEN
const T_OPEN = Date.UTC(2026, 9, 21, 4, 30) / 1000;
// Wed 2026-10-21 08:30 IST  -> before open
const T_BEFORE = Date.UTC(2026, 9, 21, 3, 0) / 1000;
// Wed 2026-10-21 15:31 IST  -> after close
const T_AFTER = Date.UTC(2026, 9, 21, 10, 1) / 1000;
// Sat 2026-10-17 10:00 IST  -> weekend
const T_SATURDAY = Date.UTC(2026, 9, 17, 4, 30) / 1000;
// Sun 2026-10-18 10:00 IST -> weekend
const T_SUNDAY = Date.UTC(2026, 9, 18, 4, 30) / 1000;
// Mon 2026-10-19 10:00 IST -> open
const T_MONDAY = Date.UTC(2026, 9, 19, 4, 30) / 1000;

async function deploy(name, args = []) {
  const contract = await (await ethers.getContractFactory(name)).deploy(...args);
  await contract.deployed();
  return contract;
}

// Next occurrence of a given UTC weekday (0=Sun..6=Sat) at 10:00 IST (04:30 UTC),
// strictly after `base`. Keeps tests independent of wherever the shared chain
// clock was left by the other specs in this repo.
function nextDayAt0430UTC(base, utcWeekday) {
  let day = Math.floor(base / 86400) + 1;
  while (new Date(day * 86400 * 1000).getUTCDay() !== utcWeekday) day += 1;
  return day * 86400 + 4.5 * 3600;
}

async function fixture() {
  const [deployer, user, liquidator, stranger] = await ethers.getSigners();

  const oracle = await deploy('EqoraPriceOracle');
  const window = await deploy('EqoraBorrowWindow');
  const gate = await deploy('EqoraAssetGate');
  const minr = await deploy('EqoraMINR');
  const reliance = await deploy('EqoraStockToken', ['Reliance Industries (Demo)', 'IND-RELIANCE']);
  const tcs = await deploy('EqoraStockToken', ['Tata Consultancy Services (Demo)', 'IND-TCS']);
  const pool = await deploy('EqoraPool', [oracle.address, window.address, gate.address, minr.address]);

  await oracle.setGate(gate.address);
  await gate.setOracle(oracle.address);

  await minr.setMinter(pool.address);

  await pool.listAsset(reliance.address, 'IND-RELIANCE', 7000, 8000);
  await pool.listAsset(tcs.address, 'IND-TCS', 6500, 7500);

  // demo balances
  await reliance.mint(user.address, E18(100));
  await tcs.mint(user.address, E18(50));

  return { deployer, user, liquidator, stranger, oracle, window, gate, minr, reliance, tcs, pool };
}

async function openMarketPrices(f) {
  await time.setNextBlockTimestamp(T_OPEN);
  await f.oracle.setPrice('IND-RELIANCE', E8(2850));
  await f.oracle.setPrice('IND-TCS', E8(4120));
}

describe('EQORA', function () {
  describe('BorrowWindow (NSE hours)', function () {
    it('allows borrowing Mon-Fri 09:15-15:30 IST', async function () {
      const f = await loadFixture(fixture);
      expect(await f.window.canBorrowAt(T_OPEN)).to.equal(true); // Wed 10:00 IST
      expect(await f.window.canBorrowAt(T_MONDAY)).to.equal(true); // Mon 10:00 IST
    });

    it('blocks before open, after close and weekends', async function () {
      const f = await loadFixture(fixture);
      expect(await f.window.canBorrowAt(T_BEFORE)).to.equal(false); // 08:30 IST
      expect(await f.window.canBorrowAt(T_AFTER)).to.equal(false); // 15:31 IST
      expect(await f.window.canBorrowAt(T_SATURDAY)).to.equal(false);
      expect(await f.window.canBorrowAt(T_SUNDAY)).to.equal(false);
    });
  });

  describe('Supply / borrow / repay', function () {
    it('user supplies collateral and borrows mINR during market hours', async function () {
      const f = await loadFixture(fixture);
      await openMarketPrices(f);

      await f.reliance.connect(f.user).approve(f.pool.address, E18(10));
      await f.pool.connect(f.user).supply(f.reliance.address, E18(10));

      // 10 * 2850 = 28,500 INR value, LTV 70% -> up to 19,950
      await time.setNextBlockTimestamp(T_OPEN + 60);
      await f.pool.connect(f.user).borrow(E18(5000));

      expect(await f.minr.balanceOf(f.user.address)).to.equal(E18(5000));
      expect(await f.pool.debtOf(f.user.address)).to.be.closeTo(E18(5000), E18(0.000001));

      // HF = (28500 * 80%) / 5000 = 4.56
      const hf = await f.pool.healthFactor(f.user.address);
      expect(hf).to.be.closeTo(E18(4.56), E18(0.05));
    });

    it('repays debt and frees the position', async function () {
      const f = await loadFixture(fixture);
      await openMarketPrices(f);
      await f.reliance.connect(f.user).approve(f.pool.address, E18(10));
      await f.pool.connect(f.user).supply(f.reliance.address, E18(10));
      await time.setNextBlockTimestamp(T_OPEN + 60);
      await f.pool.connect(f.user).borrow(E18(5000));

      // grab extra demo rupees so accrued interest is fully covered
      await f.minr.connect(f.user).faucet();
      await f.minr.connect(f.user).approve(f.pool.address, E18(6000));
      await time.setNextBlockTimestamp(T_OPEN + 120);
      await f.pool.connect(f.user).repay(E18(5001));

      expect(await f.pool.debtOf(f.user.address)).to.be.closeTo(ethers.constants.Zero, E18(0.000001));
      expect(await f.pool.healthFactor(f.user.address)).to.equal(ethers.constants.MaxUint256);
    });

    it('blocks borrowing outside the market window', async function () {
      const f = await loadFixture(fixture);
      await f.reliance.connect(f.user).approve(f.pool.address, E18(10));
      await f.pool.connect(f.user).supply(f.reliance.address, E18(10));

      const base = await time.latest();
      const tSaturday = nextDayAt0430UTC(base, 6); // next Saturday 10:00 IST
      await time.setNextBlockTimestamp(tSaturday);
      await f.oracle.setPrice('IND-RELIANCE', E8(2850));
      await time.setNextBlockTimestamp(tSaturday + 60);
      await expect(f.pool.connect(f.user).borrow(E18(1000))).to.be.revertedWith('market closed');
    });

    it('rejects borrowing beyond the LTV cap', async function () {
      const f = await loadFixture(fixture);
      await openMarketPrices(f);
      await f.reliance.connect(f.user).approve(f.pool.address, E18(10));
      await f.pool.connect(f.user).supply(f.reliance.address, E18(10));
      await time.setNextBlockTimestamp(T_OPEN + 60);
      await expect(f.pool.connect(f.user).borrow(E18(20000))).to.be.revertedWith('exceeds LTV');
    });

    it('rejects stale prices', async function () {
      const f = await loadFixture(fixture);
      await openMarketPrices(f);
      await f.reliance.connect(f.user).approve(f.pool.address, E18(10));
      await f.pool.connect(f.user).supply(f.reliance.address, E18(10));
      await time.setNextBlockTimestamp(T_OPEN + 7200); // 2h later, still in window
      await expect(f.pool.connect(f.user).borrow(E18(1000))).to.be.revertedWith('stale price');
    });

    it('accrues interest on debt over time', async function () {
      const f = await loadFixture(fixture);
      await openMarketPrices(f);
      await f.reliance.connect(f.user).approve(f.pool.address, E18(10));
      await f.pool.connect(f.user).supply(f.reliance.address, E18(10));
      await time.setNextBlockTimestamp(T_OPEN + 60);
      await f.pool.connect(f.user).borrow(E18(10000));

      await time.increase(365 * 24 * 3600);
      const debt = await f.pool.debtOf(f.user.address);
      expect(debt).to.be.gt(E18(10400)); // ~5% APR
      expect(debt).to.be.lt(E18(10600));
    });
  });

  describe('Circuit breaker (AssetGate)', function () {
    it('pauses borrowing against an asset after a >10% one-hour jump', async function () {
      const f = await loadFixture(fixture);
      await openMarketPrices(f);
      await f.reliance.connect(f.user).approve(f.pool.address, E18(10));
      await f.pool.connect(f.user).supply(f.reliance.address, E18(10));

      // 15% spike within the lookback window -> pause
      await time.setNextBlockTimestamp(T_OPEN + 60);
      await f.oracle.setPrice('IND-RELIANCE', E8(3278)); // +15%

      expect(await f.gate.isPaused('IND-RELIANCE')).to.equal(true);
      expect(await f.gate.isPaused('IND-TCS')).to.equal(false);

      await time.setNextBlockTimestamp(T_OPEN + 120);
      await expect(f.pool.connect(f.user).borrow(E18(1000))).to.be.revertedWith('exceeds LTV');

      // admin clears after review -> borrowing works again
      await time.setNextBlockTimestamp(T_OPEN + 180);
      await f.gate.clearPause('IND-RELIANCE');
      await f.oracle.setPrice('IND-RELIANCE', E8(3278));
      await time.setNextBlockTimestamp(T_OPEN + 240);
      await f.pool.connect(f.user).borrow(E18(1000));
      expect(await f.pool.debtOf(f.user.address)).to.be.closeTo(E18(1000), E18(0.000001));
    });

    it('only reporter/oracle may record prices', async function () {
      const f = await loadFixture(fixture);
      await expect(f.gate.connect(f.stranger).recordPrice('IND-RELIANCE', E8(100))).to.be.revertedWith('not reporter');
      await expect(f.oracle.connect(f.stranger).setPrice('IND-RELIANCE', E8(100))).to.be.revertedWith('not reporter');
    });
  });

  describe('Liquidation', function () {
    it('liquidates an unhealthy position with a 5% bonus', async function () {
      const f = await loadFixture(fixture);
      await openMarketPrices(f);

      // user supplies 10 RELIANCE (28,500 INR) and borrows 10,000 mINR
      await f.reliance.connect(f.user).approve(f.pool.address, E18(10));
      await f.pool.connect(f.user).supply(f.reliance.address, E18(10));
      await time.setNextBlockTimestamp(T_OPEN + 60);
      await f.pool.connect(f.user).borrow(E18(10000));

      // crash below liquidation threshold over an hour later (gradual, no halt trip
      // within lookback -> but 2850 -> 1500 in one push IS a jump, so clear the pause)
      await time.setNextBlockTimestamp(T_OPEN + 3660);
      await f.oracle.setPrice('IND-RELIANCE', E8(1500));
      await f.gate.clearPause('IND-RELIANCE');

      // HF = (10 * 1500 * 80%) / 10000 = 1.2 ... make debt heavier: price 1000
      await time.setNextBlockTimestamp(T_OPEN + 3720);
      await f.oracle.setPrice('IND-RELIANCE', E8(950));
      await f.gate.clearPause('IND-RELIANCE');

      const hf = await f.pool.healthFactor(f.user.address);
      expect(hf).to.be.lt(E18(1)); // 10*950*80% = 7600 < 10000

      // liquidator needs mINR
      await f.minr.connect(f.liquidator).faucet();
      await f.minr.connect(f.liquidator).approve(f.pool.address, E18(10000));

      const userCollateralBefore = await f.pool.collateralOf(f.user.address, f.reliance.address);
      // seize 1 token: value 950 -> debtRepaid = 950*10000/10500 = 904.76
      await time.setNextBlockTimestamp(T_OPEN + 3780);
      await f.pool.connect(f.liquidator).liquidate(f.user.address, f.reliance.address, E18(1));

      const userCollateralAfter = await f.pool.collateralOf(f.user.address, f.reliance.address);
      expect(userCollateralBefore.sub(userCollateralAfter)).to.equal(E18(1));
      expect(await f.reliance.balanceOf(f.liquidator.address)).to.equal(E18(1));
      expect(await f.pool.debtOf(f.user.address)).to.be.lt(E18(10000));
    });

    it('refuses to liquidate a healthy position', async function () {
      const f = await loadFixture(fixture);
      await openMarketPrices(f);
      await f.reliance.connect(f.user).approve(f.pool.address, E18(10));
      await f.pool.connect(f.user).supply(f.reliance.address, E18(10));
      await time.setNextBlockTimestamp(T_OPEN + 60);
      await f.pool.connect(f.user).borrow(E18(5000));
      await f.minr.connect(f.liquidator).faucet();
      await f.minr.connect(f.liquidator).approve(f.pool.address, E18(10000));
      await time.setNextBlockTimestamp(T_OPEN + 120);
      await expect(
        f.pool.connect(f.liquidator).liquidate(f.user.address, f.reliance.address, E18(1))
      ).to.be.revertedWith('position healthy');
    });
  });

  describe('mINR faucet', function () {
    it('gives anyone 10,000 demo rupees', async function () {
      const f = await loadFixture(fixture);
      await f.minr.connect(f.stranger).faucet();
      expect(await f.minr.balanceOf(f.stranger.address)).to.equal(E18(10000));
    });
  });

  describe('Emergency brake', function () {
    it('owner pauses the whole pool', async function () {
      const f = await loadFixture(fixture);
      await f.pool.setPaused(true);
      await f.reliance.connect(f.user).approve(f.pool.address, E18(10));
      await expect(f.pool.connect(f.user).supply(f.reliance.address, E18(10))).to.be.revertedWith('pool paused');
    });
  });
});
