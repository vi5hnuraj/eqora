export const AMOY = {
  id: 80002,
  name: "Polygon Amoy",
  nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_AMOY_RPC || "https://polygon-amoy-bor-rpc.publicnode.com"] } },
  blockExplorers: { default: { name: "PolygonScan", url: "https://amoy.polygonscan.com" } },
  testnet: true,
};

export const API = import.meta.env.VITE_API_URL || "http://localhost:8787";

export const CONTRACTS = {
  oracle: "0x67bA8AC8e5736dF9F1b03AF4B8139076892102fE",
  window: "0x566F545019614f001FFc832B7b02D5Cf10A4a720",
  gate: "0xEd66BC73c45303a85Bf6D1cbc6bE110F65903AcF",
  minr: "0x2619B11F344042fCED70F8ccDB9eF998A68b6D0D",
  pool: "0xDc67c69930d84E3eC5cE9e2386f464bB4391df3F",
  // EqoraGame spot venue — deployed on Amoy.
  game: "0x364Ac25908b00B26e7D6DDCa3dc5b7d38dDEC4bE",
  tokens: {
    "IND-RELIANCE": "0xCE09B893ae259090b51F19337DF6F93cb1713DaA",
    "IND-TCS": "0x775Ab463A19E51072C61bAe94A0931E00F7caa42",
    "IND-NIFTY": "0x8Ee56764A2D91b8ac5C00D87f0261Cace0036Fa9",
    "IND-HDFCBANK": "0xB5df2dF01A292AD08c96d70a6691a7233b086102",
    "IND-ICICIBANK": "0xfA1Aad0D6cE0a64C9D05670bde98aCeF92a51A8A",
    "IND-INFY": "0xb7D6985662609ce55adBEa3cc9eBE0B58f81369A",
    "IND-HINDUNILVR": "0xa65147D2328e99940387dE2a7F33fb7dEe133F6B",
    "IND-ITC": "0x53238cd2ad9228008B3627C59a98FdFE87cB814F",
    "IND-SBIN": "0xB6E9F3c66A8C9700A0C9E588e3Edb19448854698",
    "IND-BHARTIARTL": "0xBF7605eaaAe4326Aa5C41Da6750F10E08389a4cc",
    "IND-LT": "0xc2172D2F6C435540E03bA2954052866c5a973f89",
  },
};

// Full NSE watchlist shown in the ticker + Trade quickbar (Yahoo-backed).
export const SYMBOLS = [
  "IND-RELIANCE", "IND-TCS", "IND-NIFTY", "IND-HDFCBANK", "IND-ICICIBANK",
  "IND-INFY", "IND-HINDUNILVR", "IND-ITC", "IND-SBIN", "IND-BHARTIARTL", "IND-LT",
];
// Only these have a deployed collateral token + oracle entry (lendable).
export const LENDABLE = Object.keys(CONTRACTS.tokens);
export const TOKEN_BY_ADDR = Object.fromEntries(
  Object.entries(CONTRACTS.tokens).map(([sym, addr]) => [addr.toLowerCase(), sym])
);
