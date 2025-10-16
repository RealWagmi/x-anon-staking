import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { config as dotEnvConfig } from "dotenv";

dotEnvConfig();

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  solidity: {
    version: "0.8.23",
    settings: {
      optimizer: { enabled: true, runs: 999 },
      evmVersion: "paris",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    artifacts: "./artifacts",
    cache: "./cache",
  },
  gasReporter: {
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    showTimeSpent: true,
    enabled: true,
    excludeContracts: ["MockERC20", "ERC20", "MockDescriptor"],
  },
  mocha: { timeout: 120000 },
  networks: {
    sonic: {
      url: "https://rpc.soniclabs.com",
      chainId: 146,
      gas: "auto",
      gasMultiplier: 1.2,
      gasPrice: "auto",
      accounts: [`${process.env.PRIVATE_KEY}`],
    },
  },
};

export default config;
