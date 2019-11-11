/**
This acts as a layer of logic between the index.js, which lands the
rest api calls, and the heavy-lifitng coin-zkp.js and zokrates.js.  It exists so
that the amount of logic in restapi.js is absolutely minimised. It is used for paying
arbitrary amounts of currency in zero knowlege.
@module f-token-controller.js
@author westlad, Chaitanya-Konda, iAmMichaelConnor
*/

import contract from 'truffle-contract';
import jsonfile from 'jsonfile';
import config from 'config';
import zkp from './f-token-zkp';
import zokrates from './zokrates';
import cv from './compute-vectors';
import Element from './Element';
import Web3 from './web3';
import { getContract } from './contractUtils';
import utils from './zkpUtils';
import logger from './logger';

const FTokenShield = contract(jsonfile.readFileSync('./build/contracts/FTokenShield.json'));
FTokenShield.setProvider(Web3.connect());

const VerifierRegistry = contract(
  jsonfile.readFileSync('./build/contracts/Verifier_Registry.json'),
);
VerifierRegistry.setProvider(Web3.connect());

const Verifier = contract(jsonfile.readFileSync('./build/contracts/GM17_v0.json'));
Verifier.setProvider(Web3.connect());

const FToken = contract(jsonfile.readFileSync('./build/contracts/FToken.json'));
FToken.setProvider(Web3.connect());

let container;
const shield = {}; // this field holds the current Shield contract instance.

async function unlockAccount(address, password) {
  const web3 = Web3.connection();
  await web3.eth.personal.unlockAccount(address, password, 0);
}

/**
This function allocates a specific FTokenShield contract to a particular user
(or, more accurately, a particular Ethereum address)
@param {string} shieldAddress - the address of the shield contract you want to point to
@param {string} address - the Ethereum address of the user to whom this shieldAddress will apply
*/
async function setShield(shieldAddress, address) {
  if (shieldAddress === undefined) shield[address] = await FTokenShield.deployed();
  else shield[address] = await FTokenShield.at(shieldAddress);
}

function unSetShield(address) {
  delete shield[address];
}

/**
return the address of the shield contract
*/
async function getShieldAddress(account) {
  const fTokenShield = shield[account] ? shield[account] : await FTokenShield.deployed();
  return fTokenShield.address;
}

/**
return the balance of an account
@param {string} address - the address of the Ethereum account
*/
async function getBalance(address) {
  const fTokenShield = shield[address] ? shield[address] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShield.getFToken.call());
  return fToken.balanceOf.call(address);
}

/**
return the address of the ERC-20 token
*/
async function getFTAddress(address) {
  const fTokenShield = shield[address] ? shield[address] : await FTokenShield.deployed();
  return fTokenShield.getFToken.call();
}

/**
create ERC-20 in an account.  This allows one to mint more coins into the ERC-20
contract that the shield contract is using.  Obviously the ERC-20 needs to support
this functionality and most won't (as it would make the token value zero) but it's
useful to be able to create coins for demonstration purposes.
@param {string} amount - the amount of cryptocurrency to mint
@param {string} address - the address of the Ethereum account
*/
async function buyFToken(amount, address) {
  console.log('Buying ERC-20', amount, address);
  const fTokenShield = shield[address] ? shield[address] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShield.getFToken.call());
  return fToken.mint(address, amount, {
    from: address,
    gas: 4000000,
  });
}

/**
transfer ERC-20 to an account.  This allows one to transfer a token from fromAddress
to toAddress.  The tranaction fee will be taken from fromAddress
@param {string} amount - the amount of cryptocurrency to transfer
@param {string} toAddress - the address of the Ethereum account to transfer to
@param {string} fromAddress - the address of the Ethereum account to transfer from
*/
async function transferFToken(amount, fromAddress, toAddress) {
  console.log('Transferring ERC-20', amount, toAddress);
  const fTokenShield = shield[fromAddress] ? shield[fromAddress] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShield.getFToken.call());
  return fToken.transfer(toAddress, amount, {
    from: fromAddress,
    gas: 4000000,
  });
}

/**
Burn a ERC-20 token in an account.  This allows one to delete coins from the ERC-20
contract that the shield contract is using.  Obviously the ERC-20 needs to support
this functionality and most won't (as it would simply destroy value) but it's
useful to be able to delete coins for demonstration purposes.
Note: this is different functionality from 'burning' a commitment (private token).
Burning a commitment recovers the original ERC-20 value.
@param {string} amount - the amount of cryptocurrency to burn
@param {string} address - the address of the Ethereum account
*/
async function burnFToken(amount, address) {
  console.log('Buying ERC-20', amount, address);
  const fTokenShield = shield[address] ? shield[address] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShield.getFToken.call());
  return fToken.burn(address, amount, {
    from: address,
    gas: 4000000,
  });
}

/**
Return the meta data for the ERC-20 token that the user with the given address
is utilising.
@param address - the address of the user (different users may us different ERC-20 contracts)
@returns - an object containing the token symbol and name.
*/
async function getTokenInfo(address) {
  console.log('Getting ERC-20 info');
  const fTokenShield = shield[address] ? shield[address] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShield.getFToken.call());
  const symbol = await fToken.symbol.call();
  const name = await fToken.name.call();
  return { symbol, name };
}

/**
This function needs to be run *before* computing any proofs in order to deploy
the necessary code to the docker container, after instantiating the same. It
will be called automatically by computeProof if it detects tha there is no container
being instantiated.
@param {string} hostDir - the directory on the host to mount into the runContainerMounted
*/
async function setupComputeProof(hostDir) {
  container = await zokrates.runContainerMounted(hostDir);
}

/**
This function computes a proof that you own a coin, using as few parameters
as possible.  If you haven't yet deployed the code to the docker container to
enable this computation, this routine will call setupComputeProof to do that for
you.
@param {array} elements - array containing all of the public and private parameters the proof needs
@param {string} hostDir - the directory on the host to mount into the runContainerMounted
@returns the proof object
*/
async function computeProof(elements, hostDir) {
  if (container === undefined || container === null) await setupComputeProof(hostDir);

  console.log(`Container id: ${container.id}`);
  console.log(`To connect to the container manually: 'docker exec -ti ${container.id} bash'`);

  await zokrates.computeWitness(container, cv.computeVectors(elements), hostDir);

  const proof = await zokrates.generateProof(container, undefined, hostDir);

  console.group(`Proof: ${JSON.stringify(proof, undefined, 2)}`);
  console.groupEnd();

  zokrates.killContainer(container);
  container = null; // clear out the container for the next run

  return proof;
}

/**
 * Mint a coin
 * @param {String} amount - the value of the coin
 * @param {String} ownerPublicKey - Alice's public key
 * @param {String} salt - Alice's token serial number as a hex string
 * @param {String} vkId
 * @param {Object} blockchainOptions
 * @param {String} blockchainOptions.fTokenShieldJson - ABI of fTokenShield
 * @param {String} blockchainOptions.fTokenShieldAddress - Address of deployed fTokenShieldContract
 * @param {String} blockchainOptions.account - Account that is sending these transactions
 * @returns {String} commitment - Commitment of the minted coins
 * @returns {Number} commitmentIndex
 */
async function mint(amount, ownerPublicKey, salt, vkId, blockchainOptions) {
  const { fTokenShieldJson, fTokenShieldAddress } = blockchainOptions;
  const account = utils.ensure0x(blockchainOptions.account);

  const fTokenShield = contract(fTokenShieldJson);
  fTokenShield.setProvider(Web3.connect());
  const fTokenShieldInstance = await fTokenShield.at(fTokenShieldAddress);

  logger.verbose('IN MINT...');

  logger.debug('Finding the relevant Shield and Verifier contracts');
  const verifier = await Verifier.deployed();
  const verifierRegistry = await VerifierRegistry.deployed();
  logger.debug('FTokenShield contract address:', fTokenShieldInstance.address);
  logger.debug('Verifier contract address:', verifier.address);
  logger.debug('VerifierRegistry contract address:', verifierRegistry.address);

  // Calculate new arguments for the proof:
  const commitment = utils.concatenateThenHash(amount, ownerPublicKey, salt);

  logger.debug('Existing Proof Variables:');
  const p = config.ZOKRATES_PACKING_SIZE;
  const pt = Math.ceil((config.INPUTS_HASHLENGTH * 8) / config.ZOKRATES_PACKING_SIZE); // packets in bits
  logger.debug('A: ', `${amount} : `, utils.hexToFieldPreserve(amount, p, 1));
  logger.debug('pkA: ', ownerPublicKey, ' : ', utils.hexToFieldPreserve(ownerPublicKey, p, pt));
  logger.debug('S_A: ', salt, ' : ', utils.hexToFieldPreserve(salt, p, pt));

  logger.debug('New Proof Variables:');
  logger.debug('zA: ', commitment, ' : ', utils.hexToFieldPreserve(commitment, p, pt));

  const publicInputHash = utils.concatenateThenHash(amount, commitment);
  logger.debug('publicInputHash:', publicInputHash);

  // get the pwd so we can talk to the container:
  const pwd = process.env.PWD.toString();
  logger.debug(pwd);

  const hostDir = config.FT_MINT_DIR;
  logger.debug(hostDir);

  // compute the proof
  logger.debug('Computing proof with w=[pkA,S_A] x=[A,Z,1]');
  let proof = await computeProof(
    [
      new Element(publicInputHash, 'field', 248, 1),
      new Element(amount, 'field', 128, 1),
      new Element(ownerPublicKey, 'field'),
      new Element(salt, 'field'),
      new Element(commitment, 'field'),
    ],
    hostDir,
  );

  proof = Object.values(proof);
  // convert to flattened array:
  proof = utils.flattenDeep(proof);
  // convert to decimal, as the solidity functions expect uints
  proof = proof.map(el => utils.hexToDec(el));

  // Approve fTokenShield to take tokens from minter's account.
  // TODO: Make this more generic, getContract will not be part of nightfall-sdk.
  const { contractInstance: fToken } = await getContract('FToken');
  await fToken.approve(fTokenShieldInstance.address, parseInt(amount, 16), {
    from: account,
    gas: 4000000,
    gasPrice: config.GASPRICE,
  });

  logger.debug('Minting within the Shield contract');

  const inputs = cv.computeVectors([new Element(publicInputHash, 'field', 248, 1)]);

  logger.debug('proof:');
  logger.debug(proof);
  logger.debug('inputs:');
  logger.debug(inputs);
  logger.debug(`vkId: ${vkId}`);

  // Mint the commitment
  logger.debug('Approving ERC-20 spend from: ', fTokenShieldInstance.address);
  const txReceipt = await fTokenShieldInstance.mint(proof, inputs, vkId, amount, commitment, {
    from: account,
    gas: 6500000,
    gasPrice: config.GASPRICE,
  });
  logger.debug('ERC-20 spend approved!', parseInt(amount, 16));
  logger.debug('Balance of account', account, (await getBalance(account)).toNumber());

  const commitmentIndex = txReceipt.logs[0].args.commitment_index;

  const root = await fTokenShieldInstance.latestRoot();
  logger.debug(`Merkle Root after mint: ${root}`);

  logger.debug('Mint output: [zA, zAIndex]:', commitment, commitmentIndex.toString());
  logger.verbose('MINT COMPLETE\n');
  return { commitment, commitmentIndex };
}

/**
 * This function actually transfers a coin.
 * @param {Array} inputCommitments - Array of two commitments owned by the sender.
 * @param {Array} outputCommitments - Array of two commitments.
 * Currently the first is sent to the receiverPublicKey, and the second is sent to the sender.
 * @param {String} receiverPublicKey - Public key of the first outputCommitment
 * @param {String} senderSecretKey
 * @param {Object} blockchainOptions
 * @param {String} blockchainOptions.fTokenShieldJson - ABI of fTokenShield
 * @param {String} blockchainOptions.fTokenShieldAddress - Address of deployed fTokenShieldContract
 * @param {String} blockchainOptions.account - Account that is sending these transactions
 * @returns {Object[]} outputCommitments - Updated outputCommitments with their commitments and indexes.
 * @returns {Object} Transaction object
 */
async function transfer(
  inputCommitments,
  outputCommitments,
  receiverPublicKey,
  senderSecretKey,
  vkId,
  blockchainOptions,
) {
  const { fTokenShieldJson, fTokenShieldAddress } = blockchainOptions;
  const account = utils.ensure0x(blockchainOptions.account);

  const fTokenShield = contract(fTokenShieldJson);
  fTokenShield.setProvider(Web3.connect());
  const fTokenShieldInstance = await fTokenShield.at(fTokenShieldAddress);

  logger.verbose('\nIN TRANSFER...');

  // due to limitations in the size of the adder implemented in the proof dsl,
  // we need C+D and E+F to easily fit in <128 bits (16 bytes). They could of course
  // be bigger than we allow here.
  const c = parseInt(inputCommitments[0].value, 16) + parseInt(inputCommitments[1].value, 16);
  const e = parseInt(outputCommitments[0].value, 16) + parseInt(outputCommitments[1].value, 16);
  if (c > 0xffffffff || e > 0xffffffff) throw new Error('Coin values are too large');

  logger.debug('Finding the relevant Shield and Verifier contracts');
  const verifier = await Verifier.deployed();
  const verifierRegistry = await VerifierRegistry.deployed();
  logger.debug('FTokenShield contract address:', fTokenShieldInstance.address);
  logger.debug('Verifier contract address:', verifier.address);
  logger.debug('VerifierRegistry contract address:', verifierRegistry.address);

  const root = await fTokenShieldInstance.latestRoot();
  logger.debug(`Merkle Root: ${root}`);

  // Calculate new arguments for the proof:
  const pkA = utils.hash(senderSecretKey);
  const nC = utils.concatenateThenHash(inputCommitments[0].salt, senderSecretKey);
  const nD = utils.concatenateThenHash(inputCommitments[1].salt, senderSecretKey);
  const zE = utils.concatenateThenHash(
    outputCommitments[0].value,
    receiverPublicKey,
    outputCommitments[0].salt,
  );
  const zF = utils.concatenateThenHash(outputCommitments[1].value, pkA, outputCommitments[1].salt);

  // we need the Merkle path from the token commitment to the root, expressed as Elements
  const pathC = await cv.computePath(
    account,
    fTokenShieldInstance,
    inputCommitments[0].commitment,
    inputCommitments[0].index,
  );
  const pathCElements = {
    elements: pathC.path.map(
      element => new Element(element, 'field', config.MERKLE_HASHLENGTH * 8, 1),
    ), // we truncate to 216 bits - sending the whole 256 bits will overflow the prime field
    positions: new Element(pathC.positions, 'field', 128, 1),
  };

  const pathD = await cv.computePath(
    account,
    fTokenShieldInstance,
    inputCommitments[1].commitment,
    inputCommitments[1].index,
  );
  const pathDElements = {
    elements: pathD.path.map(
      element => new Element(element, 'field', config.MERKLE_HASHLENGTH * 8, 1),
    ), // we truncate to 216 bits - sending the whole 256 bits will overflow the prime field
    positions: new Element(pathD.positions, 'field', 128, 1),
  };

  // Although we only strictly need the root to be reconciled within zokrates, it's easier to check and intercept any errors in js; so we'll first try to reconcole here:
  cv.checkRoot(inputCommitments[0].commitment, pathC, root);
  cv.checkRoot(inputCommitments[1].commitment, pathD, root);

  logger.debug('Existing Proof Variables:');
  const p = config.ZOKRATES_PACKING_SIZE;
  logger.debug(
    `C: ${inputCommitments[0].value} : ${utils.hexToFieldPreserve(inputCommitments[0].value, p)}`,
  );
  logger.debug(
    `D: ${inputCommitments[1].value} : ${utils.hexToFieldPreserve(inputCommitments[1].value, p)}`,
  );
  logger.debug(
    `E: ${outputCommitments[0].value} : ${utils.hexToFieldPreserve(outputCommitments[0].value, p)}`,
  );
  logger.debug(
    `F: ${outputCommitments[1].value} : ${utils.hexToFieldPreserve(outputCommitments[1].value, p)}`,
  );
  logger.debug(`pkB: ${receiverPublicKey} : ${utils.hexToFieldPreserve(receiverPublicKey, p)}`);
  logger.debug(
    `S_C: ${inputCommitments[0].salt} : ${utils.hexToFieldPreserve(inputCommitments[0].salt, p)}`,
  );
  logger.debug(
    `S_D: ${inputCommitments[1].salt} : ${utils.hexToFieldPreserve(inputCommitments[1].salt, p)}`,
  );
  logger.debug(
    `S_E: ${outputCommitments[0].salt} : ${utils.hexToFieldPreserve(outputCommitments[0].salt, p)}`,
  );
  logger.debug(
    `S_F: ${outputCommitments[1].salt} : ${utils.hexToFieldPreserve(outputCommitments[1].salt, p)}`,
  );
  logger.debug(`skA: ${senderSecretKey} : ${utils.hexToFieldPreserve(senderSecretKey, p)}`);
  logger.debug(
    `zC: ${inputCommitments[0].commitment} : ${utils.hexToFieldPreserve(
      inputCommitments[0].commitment,
      p,
    )}`,
  );
  logger.debug(
    `zD: ${inputCommitments[1].commitment} : ${utils.hexToFieldPreserve(
      inputCommitments[1].commitment,
      p,
    )}`,
  );

  logger.debug('New Proof Variables:');
  logger.debug(`pkA: ${pkA} : ${utils.hexToFieldPreserve(pkA, p)}`);
  logger.debug(`nC: ${nC} : ${utils.hexToFieldPreserve(nC, p)}`);
  logger.debug(`nD: ${nD} : ${utils.hexToFieldPreserve(nD, p)}`);
  logger.debug(`zE: ${zE} : ${utils.hexToFieldPreserve(zE, p)}`);
  logger.debug(`zF: ${zF} : ${utils.hexToFieldPreserve(zF, p)}`);
  logger.debug(`root: ${root} : ${utils.hexToFieldPreserve(root, p)}`);

  const publicInputHash = utils.concatenateThenHash(root, nC, nD, zE, zF);
  logger.debug('publicInputHash:', publicInputHash);

  // get the pwd so we can talk to the container:
  const pwd = process.env.PWD.toString();
  logger.debug(pwd);

  const hostDir = config.FT_TRANSFER_DIR;
  logger.debug(hostDir);

  // compute the proof
  logger.debug(
    'Computing proof with w=[C,D,E,F,S_C,S_D,S_E,S_F,pathC[], orderC,pathD[], orderD,skA,pkB]  x=[nC,nD,zE,zF,root,1]',
  );
  logger.debug(
    'vector order: [C,skA,S_C,pathC[0...31],orderC,D,S_D,pathD[0...31], orderD,nC,nD,E,pkB,S_E,zE,F,S_F,zF,root]',
  );
  let proof = await computeProof(
    [
      new Element(publicInputHash, 'field', 248, 1),
      new Element(inputCommitments[0].value, 'field', 128, 1),
      new Element(senderSecretKey, 'field'),
      new Element(inputCommitments[0].salt, 'field'),
      ...pathCElements.elements.slice(1),
      pathCElements.positions,
      new Element(inputCommitments[1].value, 'field', 128, 1),
      new Element(inputCommitments[1].salt, 'field'),
      ...pathDElements.elements.slice(1),
      pathDElements.positions,
      new Element(nC, 'field'),
      new Element(nD, 'field'),
      new Element(outputCommitments[0].value, 'field', 128, 1),
      new Element(receiverPublicKey, 'field'),
      new Element(outputCommitments[0].salt, 'field'),
      new Element(zE, 'field'),
      new Element(outputCommitments[1].value, 'field', 128, 1),
      new Element(outputCommitments[1].salt, 'field'),
      new Element(zF, 'field'),
      new Element(root, 'field'),
    ],
    hostDir,
  );

  proof = Object.values(proof);
  // convert to flattened array:
  proof = utils.flattenDeep(proof);
  // convert to decimal, as the solidity functions expect uints
  proof = proof.map(el => utils.hexToDec(el));

  logger.debug('Transferring within the Shield contract');

  const inputs = cv.computeVectors([new Element(publicInputHash, 'field', 248, 1)]);

  logger.debug('proof:');
  logger.debug(proof);
  logger.debug('inputs:');
  logger.debug(inputs);

  logger.debug(`vkId: ${vkId}`);

  // Transfers commitment
  const transferReceipt = await fTokenShieldInstance.transfer(
    proof,
    inputs,
    vkId,
    root,
    nC,
    nD,
    zE,
    zF,
    {
      from: account,
      gas: 6500000,
      gasPrice: config.GASPRICE,
    },
  );

  const newRoot = await fTokenShieldInstance.latestRoot();
  logger.debug(`Merkle Root after transfer: ${newRoot}`);

  const zEIndex = transferReceipt.logs[0].args.commitment1_index;
  const zFIndex = transferReceipt.logs[0].args.commitment2_index;

  logger.verbose('TRANSFER COMPLETE\n');
  return {
    outputCommitments: [
      {
        commitment: zE,
        index: zEIndex,
        salt: outputCommitments[0].salt,
      },
      {
        commitment: zF,
        index: zFIndex,
        salt: outputCommitments[1].salt,
      },
    ],
    transferReceipt,
  };
}

/**
 * This function burns a commitment, i.e. it recovers ERC-20 into your
 * account. All values are hex strings.
 * @param {string} amount - the value of the commitment in hex (i.e. the amount you are burning)
 * @param {string} receiverSecretKey - the secret key of the person doing the burning (in hex)
 * @param {string} salt - the random nonce used in the commitment
 * @param {string} commitment - the value of the commitment being burned
 * @param {string} commitmentIndex - the index of the commitment in the Merkle Tree
 * @param {Object} blockchainOptions
 * @param {String} blockchainOptions.fTokenShieldJson - ABI of fTokenShield
 * @param {String} blockchainOptions.fTokenShieldAddress - Address of deployed fTokenShieldContract
 * @param {String} blockchainOptions.account - Account that is sending these transactions
 * @param {String} blockchainOptions.tokenReceiver - Account that will receive the tokens
 */
async function burn(
  amount,
  receiverSecretKey,
  salt,
  commitment,
  commitmentIndex,
  vkId,
  blockchainOptions,
) {
  const { fTokenShieldJson, fTokenShieldAddress, tokenReceiver: _payTo } = blockchainOptions;

  const account = utils.ensure0x(blockchainOptions.account);

  const fTokenShield = contract(fTokenShieldJson);
  fTokenShield.setProvider(Web3.connect());
  const fTokenShieldInstance = await fTokenShield.at(fTokenShieldAddress);

  let payTo = _payTo;
  if (payTo === undefined) payTo = account; // have the option to pay out to another address
  // before we can burn, we need to deploy a verifying key to mintVerifier (reusing mint for this)
  logger.verbose('\nIN BURN...');

  logger.debug('Finding the relevant Shield and Verifier contracts');
  const verifier = await Verifier.deployed();
  const verifierRegistry = await VerifierRegistry.deployed();
  logger.debug('FTokenShield contract address:', fTokenShieldInstance.address);
  logger.debug('Verifier contract address:', verifier.address);
  logger.debug('VerifierRegistry contract address:', verifierRegistry.address);

  const root = await fTokenShieldInstance.latestRoot(); // solidity getter for the public variable latestRoot
  logger.debug(`Merkle Root: ${root}`);

  // Calculate new arguments for the proof:
  const Nc = utils.concatenateThenHash(salt, receiverSecretKey);

  // We need the Merkle path from the commitment to the root, expressed as Elements
  const path = await cv.computePath(account, fTokenShieldInstance, commitment, commitmentIndex);
  const pathElements = {
    elements: path.path.map(
      element => new Element(element, 'field', config.MERKLE_HASHLENGTH * 8, 1),
    ), // We can fit the 216 bit hash into a single field - more compact
    positions: new Element(path.positions, 'field', 128, 1),
  };

  // Although we only strictly need the root to be reconciled within zokrates, it's easier to check and intercept any errors in js; so we'll first try to reconcole here:
  cv.checkRoot(commitment, path, root);

  // Summarise values in the console:
  logger.debug('Existing Proof Variables:');
  const p = config.ZOKRATES_PACKING_SIZE;
  logger.debug(`C: ${amount} : ${utils.hexToFieldPreserve(amount, p)}`);
  logger.debug(`skA: ${receiverSecretKey} : ${utils.hexToFieldPreserve(receiverSecretKey, p)}`);
  logger.debug(`S_C: ${salt} : ${utils.hexToFieldPreserve(salt, p)}`);
  logger.debug(`payTo: ${payTo} : ${utils.hexToFieldPreserve(payTo, p)}`);
  const payToLeftPadded = utils.leftPadHex(payTo, config.INPUTS_HASHLENGTH * 2); // left-pad the payToAddress with 0's to fill all 256 bits (64 octets) (so the sha256 function is hashing the same thing as inside the zokrates proof)
  logger.debug(`payToLeftPadded: ${payToLeftPadded}`);

  logger.debug('New Proof Variables:');
  logger.debug(`Nc: ${Nc} : ${utils.hexToFieldPreserve(Nc, p)}`);
  logger.debug(`zC: ${commitment} : ${utils.hexToFieldPreserve(commitment, p)}`);
  logger.debug(`root: ${root} : ${utils.hexToFieldPreserve(root, p)}`);

  const publicInputHash = utils.concatenateThenHash(root, Nc, amount, payToLeftPadded); // notice we're using the version of payTo which has been padded to 256-bits; to match our derivation of publicInputHash within our zokrates proof.
  logger.debug('publicInputHash:', publicInputHash);

  // get the pwd so we can talk to the container:
  const pwd = process.env.PWD.toString();
  logger.debug(pwd);

  const hostDir = config.FT_BURN_DIR;
  logger.debug(hostDir);

  // compute the proof
  logger.debug('Computing proof with w=[skA,S_C,path[],order] x=[C,Nc,root,1]');
  let proof = await computeProof(
    [
      new Element(publicInputHash, 'field', 248, 1),
      new Element(payTo, 'field'),
      new Element(amount, 'field', 128, 1),
      new Element(receiverSecretKey, 'field'),
      new Element(salt, 'field'),
      ...pathElements.elements.slice(1),
      pathElements.positions,
      new Element(Nc, 'field'),
      new Element(root, 'field'),
    ],
    hostDir,
  );

  proof = Object.values(proof);
  // convert to flattened array:
  proof = utils.flattenDeep(proof);
  // convert to decimal, as the solidity functions expect uints
  proof = proof.map(el => utils.hexToDec(el));

  logger.debug('Burning within the Shield contract');

  const inputs = cv.computeVectors([new Element(publicInputHash, 'field', 248, 1)]);

  logger.debug('proof:');
  logger.debug(proof);
  logger.debug('inputs:');
  logger.debug(inputs);
  logger.debug(`vkId: ${vkId}`);

  // Burn the commitment and return tokens to the payTo account.
  await fTokenShieldInstance.burn(proof, inputs, vkId, root, Nc, amount, payTo, {
    from: account,
    gas: 6500000,
    gasPrice: config.GASPRICE,
  });

  const newRoot = await fTokenShieldInstance.latestRoot();
  logger.debug(`Merkle Root after burn: ${newRoot}`);

  logger.verbose('BURN COMPLETE\n');
  return { z_C: commitment, z_C_index: commitmentIndex };
}

async function checkCorrectness(C, pk, S, z, zIndex, account) {
  const fTokenShield = shield[account] ? shield[account] : await FTokenShield.deployed();

  const results = await zkp.checkCorrectness(C, pk, S, z, zIndex, fTokenShield);
  logger.debug('\nf-token-controller', '\ncheckCorrectness', '\nresults', results);

  return results;
}

export default {
  burn,
  transfer,
  mint,
  computeProof,
  setupComputeProof,
  getBalance,
  getFTAddress,
  buyFToken,
  transferFToken,
  burnFToken,
  getTokenInfo,
  unlockAccount,
  setShield,
  unSetShield,
  checkCorrectness,
  getShieldAddress,
};
