/**
@module vk-controller.js
@author iAmMichaelConnor
@desc this acts as a layer of logic between the restapi.js, which lands the
rest api calls, and the heavy-lifitng token-zkp.js and zokrates.js.  It exists so that the amount of logic in restapi.js is absolutely minimised.
*/

import contract from 'truffle-contract';
import jsonfile from 'jsonfile';
import fs from 'fs';
import utils from 'zkp-utils';
import config from 'config';
import Web3 from './web3';
import { getContract } from './contractUtils';

const web3 = Web3.connection();

/**
Loads a verification key to the Verifier Registry
 * @param {String} vkJsonFile - Path to vk file in JSON form
 * @param {Object} blockchainOptions
 * @param {Object} blockchainOptions.verifierJson - Compiled JSON of verifier contract
 * @param {String} blockchainOptions.verifierAddress - address of deployed verifier contract
 * @param {Object} blockchainOptions.verifierRegistryJson - Compiled JSON of verifier contract
 * @param {String} blockchainOptions.verifierRegistryAddress - address of deployed verifier contract
 * @param {String} blockchainOptions.account - Account that will send the transactions
*/
async function loadVk(vkJsonFile, blockchainOptions) {
  const {
    verifierJson,
    verifierAddress,
    verifierRegistryJson,
    verifierRegistryAddress,
    account,
  } = blockchainOptions;

  console.log(`Loading VK for ${vkJsonFile}`);

  const verifier = contract(verifierJson);
  verifier.setProvider(Web3.connect());
  const verifierInstance = await verifier.at(verifierAddress);

  const verifierRegistry = contract(verifierRegistryJson);
  verifierRegistry.setProvider(Web3.connect());
  const verifierRegistryInstance = await verifierRegistry.at(verifierRegistryAddress);

  // Get VKs from the /code/gm17 directory and convert them into Solidity uints.
  let vk = await new Promise((resolve, reject) => {
    jsonfile.readFile(vkJsonFile, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
  vk = Object.values(vk);
  vk = utils.flattenDeep(vk);
  vk = vk.map(el => utils.hexToDec(el));

  // upload the vk to the smart contract
  console.log('Registering verifying key');
  const txReceipt = await verifierRegistryInstance.registerVk(vk, [verifierInstance.address], {
    from: account,
    gas: 6500000,
    gasPrice: config.GASPRICE,
  });

  // eslint-disable-next-line no-underscore-dangle
  const vkId = txReceipt.logs[0].args._vkId;

  return vkId;
}

/**
 * Loads VKs to the VerifierRegistry, saves the VkIds to a JSON file, then submits the VkIds to the Shield contracts
 */
async function initializeVks() {
  const accounts = await web3.eth.getAccounts();
  const account = accounts[0];

  // Get Verifier
  const { contractJson: verifierJson, contractInstance: verifier } = await getContract('Verifier');
  const {
    contractJson: verifierRegistryJson,
    contractInstance: verifierRegistry,
  } = await getContract('VerifierRegistry');

  const blockchainOptions = {
    verifierJson,
    verifierAddress: verifier.address,
    verifierRegistryJson,
    verifierRegistryAddress: verifierRegistry.address,
    account,
  };

  let ids;

  // Load VK to VerifierRegistry and get back vkIds
  try {
    ids = await Promise.all([
      loadVk(config.NFT_MINT_VK, blockchainOptions),
      loadVk(config.NFT_TRANSFER_VK, blockchainOptions),
      loadVk(config.NFT_BURN_VK, blockchainOptions),
      loadVk(config.FT_MINT_VK, blockchainOptions),
      loadVk(config.FT_TRANSFER_VK, blockchainOptions),
      loadVk(config.FT_BURN_VK, blockchainOptions),
    ]);
  } catch (err) {
    throw new Error('Error while loading VKs', err);
  }

  // Construct an object that will be written out as a JSON file.
  const vkIdObject = {
    MintToken: {
      vkId: ids[0],
      Address: account,
    },
    TransferToken: {
      vkId: ids[1],
      Address: account,
    },
    BurnToken: {
      vkId: ids[2],
      Address: account,
    },
    MintCoin: {
      vkId: ids[3],
      Address: account,
    },
    TransferCoin: {
      vkId: ids[4],
      Address: account,
    },
    BurnCoin: {
      vkId: ids[5],
      Address: account,
    },
  };

  // Write these VK Ids to a JSON file at config.VK_IDS
  const vkIdsAsJson = JSON.stringify(vkIdObject, null, 2);
  await new Promise((resolve, reject) => {
    fs.writeFile(config.VK_IDS, vkIdsAsJson, err => {
      if (err) {
        console.log(
          `fs.writeFile has failed when writing the new vk information to vkIds.json. Here's the error:`,
        );
        reject(err);
      }
      console.log(`writing to ${config.VK_IDS}`);
      resolve();
    });
  });

  const { contractInstance: nfTokenShield } = await getContract('NFTokenShield');
  const { contractInstance: fTokenShield } = await getContract('FTokenShield');

  // Set these vkIds for the shield contracts.
  await nfTokenShield.setVkIds(
    vkIdObject.MintToken.vkId,
    vkIdObject.TransferToken.vkId,
    vkIdObject.BurnToken.vkId,
    {
      from: account,
      gas: 6500000,
      gasPrice: config.GASPRICE,
    },
  );
  await fTokenShield.setVkIds(
    vkIdObject.MintCoin.vkId,
    vkIdObject.TransferCoin.vkId,
    vkIdObject.BurnCoin.vkId,
    {
      from: account,
      gas: 6500000,
      gasPrice: config.GASPRICE,
    },
  );

  console.log('VK setup complete');
}

async function runController() {
  await initializeVks();
}

if (process.env.NODE_ENV !== 'test') runController();

export default {
  runController,
};
