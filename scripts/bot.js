// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// You can also run a script with `npx hardhat run <script>`. If you do that, Hardhat
// will compile your contracts, add the Hardhat Runtime Environment's members to the
// global scope, and execute the script.
const hre = require("hardhat");
const { ethers } = require("ethers");
require("dotenv").config();
var colors = require("colors");

colors.setTheme({
  custom: ["rainbow", "bold", "underline", "dim"],
});

const mainnetData = require("../addresses/mainnet.json");
const priceFeedAbi = require("../abi/PriceFeed.json");
const multiTroveGetterAbi = require("../abi/MultiTroveGetter.json");
const troveManagerAbi = require("../abi/TroveManager.json");
const troveManagerHelpersAbi = require("../abi/TroveManagerHelpers.json");

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;

async function main() {
  const provider = new ethers.providers.WebSocketProvider(
    MAINNET_RPC_URL,
    "mainnet"
  );

  /** Smart Contracts */

  //priceFeed for listening to new ETH price
  const priceFeedAddress = mainnetData.addresses["priceFeed"];
  const priceFeed = new ethers.Contract(
    priceFeedAddress,
    priceFeedAbi,
    provider
  );

  // possible to fetch all troves in a sorted list
  const multiTroveGetterAddress = mainnetData.addresses["multiTroveGetter"];
  const multiTroveGetter = await hre.ethers.getContractAt(
    multiTroveGetterAbi,
    multiTroveGetterAddress
  );

  const signer = await hre.ethers.getSigner();

  // troveManager: to get current ICR of the troves
  const troveManagerAddress = mainnetData.addresses["troveManager"];
  const troveManager = await hre.ethers.getContractAt(
    troveManagerAbi,
    troveManagerAddress,
    signer
  );

  const troveManagerHelpersAddress =
    mainnetData.addresses["TroveManagerHelpers"];
  const troveManagerHelpers = await hre.ethers.getContractAt(
    troveManagerHelpersAbi,
    troveManagerHelpersAddress
  );

  /** State Variables */

  const zero = ethers.BigNumber.from("0");
  const lastPrice = {
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": zero, //wBTC
    "0x0000000000000000000000000000000000000000": zero, //ETH
  };

  const liquidationPrice = {
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": zero, //wBTC
    "0x0000000000000000000000000000000000000000": zero, //ETH
  };

  const troves = {
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": [], //wBTC
    "0x0000000000000000000000000000000000000000": [], //ETH
  };

  // Check if interval is ongoing
  let interval = false;
  let intervalPriceCheck;

  /** Start Bot */
  console.log("");
  console.log(colors.custom(`====== DefiFranc BOT ======`));
  console.log("");
  log("-----------------------------", "blue");
  log("Starting with Chainlink price...", "blue");

  for (address in liquidationPrice) {
    log(`Check ChainLink Price for ${address}`, "green");
    const _chainLinkPrice = await getChainLinkPrice(signer, address);
    log(`Last Price is ${_chainLinkPrice}`, "green");
    troves[address] = await multiTroveGetter.getMultipleSortedTroves(
      address,
      -1,
      50
    );
    liquidationPrice[address] = await checkColletaral(
      troves[address],
      troveManager,
      troveManagerHelpers,
      ethers.utils.parseEther(_chainLinkPrice),
      address
    );
  }

  log("-----------------------------", "blue");
  log("Starting looking for event...", "blue");

  /** Event Listeners */

  priceFeed.on("LastGoodPriceUpdated", async (address, price) => {
    log(`new price from pricefeed: ${price} for ${address}`, "green");
    log(`Liquidation Price ${liquidationPrice[address]}`, "red");
    if (liquidationPrice[address].lt(price)) {
      log(`token address: ${address}`, "green");
      log(
        `price: ${ethers.utils.formatEther(
          price
        )} is greater than ${ethers.utils.formatEther(
          liquidationPrice[address]
        )}`,
        "green"
      );
      troves[address] = await multiTroveGetter.getMultipleSortedTroves(
        address,
        -1,
        50
      );
      //If new price is lower than the last price
      // check all troves for the new Current ICR
      liquidationPrice[address] = await checkColletaral(
        troves[address],
        troveManager,
        troveManagerHelpers,
        price,
        address
      );

      const icr = await troveManagerHelpers.getCurrentICR(
        address,
        troves[address][0].owner,
        price
      );

      if (parseFloat(ethers.utils.formatEther(icr)) <= 1.15) {
        if (!interval) {
          intervalPriceCheck = setInterval(
            async () =>
              await checkToLiquidate(
                signer,
                liquidationPrice,
                troves,
                troveManager,
                troveManagerHelpers
              ),
            50000
          );
          interval = true;
        }
      } else {
        if (interval) {
          clearInterval(intervalPriceCheck);
          interval = false;
        }
      }
    }
  });

  troveManagerHelpers.on("TroveIndexUpdated", async (address) => {
    log(`Trove Index updated for ${address} `, "blue");
    troves[address] = await multiTroveGetter.getMultipleSortedTroves(
      address,
      -1,
      50
    );
    const _price = await getChainLinkPrice(signer, address);
    liquidationPrice[address] = await checkColletaral(
      troves[address],
      troveManager,
      troveManagerHelpers,
      ethers.utils.parseEther(_price),
      address
    );
  });
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function log(message, color) {
  const _color = color ? color : "blue";
  console.log(
    colors[_color](`[${new Date().toLocaleTimeString()}] ${message}`)
  );
}

const checkColletaral = async (
  troves,
  troveManager,
  troveManagerHelpers,
  currentPrice,
  address
) => {
  let liquidationPrice;
  try {
    // const icr = await troveManagerHelpers.getCurrentICR(
    //   address,
    //   troves[0].owner,
    //   currentPrice
    // );
    // console.log(icr);
    let liquidateTroves = [];
    if (troves.length) {
      for (let index = 0; index < troves.length; index++) {
        const trove = troves[index];
        log(`${index + 1}. trove: ${trove.owner}`, "red");
        const icr = await troveManagerHelpers.getCurrentICR(
          address,
          trove.owner,
          currentPrice
        );
        const icrNumber = parseFloat(ethers.utils.formatEther(icr));
        log(`current ICR: ${icrNumber}`, "red");
        if (icrNumber >= 1.1) {
          if (liquidateTroves.length === 0) {
            log("No Troves can be liquidate...");
          }
          liquidationPrice =
            (parseFloat(ethers.utils.formatEther(currentPrice)) * 1.1) /
            icrNumber;
          break;
        }
        liquidateTroves.push(trove);
      }
      log("trove check ends...", "blue");

      // Use batchLiquidate if some troves can liquidate
      if (liquidateTroves.length > 0) {
        log(`try to liquidate ${troves.length} trove(s)...`);

        const tx = await troveManager.batchLiquidateTroves(
          address,
          liquidateTroves
        );

        const receipt = await tx.wait(1);

        if (receipt.status == 1) {
          log("Succesfull liquidate trove(s)...", "green");
        }
      }
      log(`Actual liquidation price is ${liquidationPrice}`);
    }
    return ethers.utils.parseEther(liquidationPrice.toString());
  } catch (e) {
    log(`error: ${e}`);
  }
};

const getChainLinkPrice = async (signer, address) => {
  const chainlinkPriceFeedAddress = mainnetData["chainLinkPriceFeed"][address];

  const _contractData = require("../artifacts/@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol/AggregatorV3Interface.json");
  const chainlinkPriceFeed = await hre.ethers.getContractAt(
    _contractData["abi"],
    chainlinkPriceFeedAddress,
    signer
  );

  const _latestData = await chainlinkPriceFeed.latestRoundData();
  const _price =
    parseFloat(hre.ethers.utils.formatEther(_latestData[1])) * 10 ** 10;
  log(`chainlink price: ${_price}`, "red");

  return _price.toString();
};

async function checkToLiquidate(
  signer,
  liquidationPrice,
  troves,
  troveManager,
  troveManagerHelpers
) {
  for (address in liquidationPrice) {
    const _price = await getChainLinkPrice(signer, address);

    if (parseFloat(_price) <= liquidationPrice[address]) {
      await checkColletaral(
        troves[address],
        troveManager,
        troveManagerHelpers,
        ethers.utils.parseEther(_price),
        address
      );
    }
  }
}
