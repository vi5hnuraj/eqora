// Local reproduction setup extended for the EQORA submission:
// - hardhat (in-process) for tests, exactly as the inherited config
// - polygonAmoy testnet for the public demo deployment
// PRIVATE_KEY is read from contracts/.env (gitignored) — never committed.
require('@nomicfoundation/hardhat-toolbox');

try {
  process.loadEnvFile(__dirname + '/.env');
} catch (_) {
  /* no .env — local tests still work */
}

const PRIVATE_KEY = process.env.PRIVATE_KEY || '';

module.exports = {
  solidity: {
    version: '0.8.27',
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', metadata: { bytecodeHash: 'none' } },
  },
  networks: {
    hardhat: { chainId: 31337 },
    polygonAmoy: {
      url: process.env.AMOY_RPC_URL || 'https://polygon-amoy-bor-rpc.publicnode.com',
      chainId: 80002,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      // Amoy's suggested gas price spikes 10-15x between idle and send, which
      // makes deploy cost unpredictable. Cap it so cost stays bounded. 25 gwei
      // is the observed floor on the public RPC (base fee is near zero).
      gasPrice: Number(process.env.AMOY_GAS_PRICE || 25_000_000_000),
    },
  },
  paths: { sources: './src', tests: './test', cache: './cache', artifacts: './artifacts' },
  typechain: { outDir: './typechain' },
  mocha: { timeout: 120000 },
};
