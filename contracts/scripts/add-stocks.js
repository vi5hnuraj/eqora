// EQORA — add the remaining NSE watchlist stocks as on-chain collateral.
// Run: npx hardhat run scripts/add-stocks.js --network polygonAmoy
// Resumable: skips any token already deployed (verified by on-chain code) and
// any asset already listed in the pool. Sets an initial oracle price from
// Yahoo so the pool can price the collateral immediately.
const fs = require('fs');
const path = require('path');
const { ethers } = require('hardhat');

const FILE = path.join(__dirname, '..', 'deployments', 'polygonAmoy.json');

// symbol -> [display name, ltvBps, liqThresholdBps, yahoo ticker]
const NEW_STOCKS = {
  'IND-HDFCBANK': ['HDFC Bank (Demo)', 7000, 8000, 'HDFCBANK.NS'],
  'IND-ICICIBANK': ['ICICI Bank (Demo)', 7000, 8000, 'ICICIBANK.NS'],
  'IND-INFY': ['Infosys (Demo)', 6500, 7500, 'INFY.NS'],
  'IND-HINDUNILVR': ['Hindustan Unilever (Demo)', 6500, 7500, 'HINDUNILVR.NS'],
  'IND-ITC': ['ITC Limited (Demo)', 7000, 8000, 'ITC.NS'],
  'IND-SBIN': ['State Bank of India (Demo)', 6500, 7500, 'SBIN.NS'],
  'IND-BHARTIARTL': ['Bharti Airtel (Demo)', 6500, 7500, 'BHARTIARTL.NS'],
  'IND-LT': ['Larsen & Toubro (Demo)', 7000, 8000, 'LT.NS'],
};

function loadState() {
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2) + '\n');
}

async function hasCode(address) {
  if (!address) return false;
  const code = await ethers.provider.getCode(address);
  return code && code !== '0x';
}

async function fetchYahooPrice(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo ${ticker} HTTP ${res.status}`);
  const body = await res.json();
  const price = body?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (typeof price !== 'number' || price <= 0) throw new Error(`Yahoo ${ticker}: no price`);
  return price;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`chainId=${net.chainId} deployer=${deployer.address}`);

  const state = loadState();
  const oracle = await ethers.getContractAt('EqoraPriceOracle', state.contracts.EqoraPriceOracle);
  const pool = await ethers.getContractAt('EqoraPool', state.contracts.Pool);

  let newCount = 0;
  for (const [symbol, [name, ltv, liq, ticker]] of Object.entries(NEW_STOCKS)) {
    // 1) deploy token if missing
    let fresh = false;
    let addr = state.contracts[symbol];
    if (!(await hasCode(addr))) {
      const factory = await ethers.getContractFactory('EqoraStockToken');
      const token = await factory.deploy(name, symbol);
      await token.deployed();
      addr = token.address;
      state.contracts[symbol] = addr;
      saveState(state);
      console.log(`${symbol}: deploy ${addr}`);
      newCount++;
      fresh = true;
    } else {
      console.log(`${symbol}: reuse ${addr}`);
    }

    // 2) list in pool if not already an asset (ethers returns a tuple)
    const asset = await pool.assets(addr);
    const isListed = asset[0] === true || asset.listed === true;
    if (!isListed) {
      await (await pool.listAsset(addr, symbol, ltv, liq)).wait();
      console.log(`${symbol}: listed ltv=${ltv / 100}% liq=${liq / 100}%`);
      fresh = true;
    } else {
      console.log(`${symbol}: already listed`);
    }

    // 3) seed oracle price from Yahoo — only for tokens we just deployed or
    // just listed; already-live assets are kept fresh by the reporter (and
    // re-pushing them here wasted ~0.002 POL of gas per symbol per run).
    if (fresh) {
      try {
        const price = await fetchYahooPrice(ticker);
        await (await oracle.setPrice(symbol, ethers.utils.parseUnits(price.toFixed(8), 8))).wait();
        console.log(`${symbol}: oracle ₹${price}`);
      } catch (e) {
        console.log(`${symbol}: oracle SKIPPED (${e.message})`);
      }
    } else {
      console.log(`${symbol}: oracle up to date (reporter)`);
    }
  }

  state.updatedAt = new Date().toISOString();
  saveState(state);
  console.log(`done. ${newCount} newly deployed. written: ${FILE}`);
  console.log(JSON.stringify(state.contracts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
