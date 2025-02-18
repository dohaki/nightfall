/**
This acts as a layer of logic between the index.js, which lands the
rest api calls, and the heavy-lifitng coin-zkp.js and zokrates.js.  It exists so
that the amount of logic in restapi.js is absolutely minimised. It is used for paying
arbitrary amounts of currency in zero knowlege.
@module f-token-controller.js
@author westlad, Chaitanya-Konda, iAmMichaelConnor
*/

import contract from 'truffle-contract';
import config from 'config';
import jsonfile from 'jsonfile';
// eslint-disable-next-line import/extensions
import zokrates from '@eyblockchain/zokrates.js';
import fs from 'fs';
import zkp from './f-token-zkp';
import { computeVectors, computePath, checkRoot } from './compute-vectors';
import Element from './Element';

import Web3 from './web3';
import { getContract } from './contractUtils';
import utils from './zkpUtils';

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
  const fTokenShieldInstance = shield[account] ? shield[account] : await FTokenShield.deployed();
  return fTokenShieldInstance.address;
}

/**
return the balance of an account
@param {string} address - the address of the Ethereum account
*/
async function getBalance(address) {
  const fTokenShieldInstance = shield[address] ? shield[address] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShieldInstance.getFToken.call());
  return fToken.balanceOf.call(address);
}

/**
return the address of the ERC-20 token
*/
async function getFTAddress(address) {
  const fTokenShieldInstance = shield[address] ? shield[address] : await FTokenShield.deployed();
  return fTokenShieldInstance.getFToken.call();
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
  const fTokenShieldInstance = shield[address] ? shield[address] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShieldInstance.getFToken.call());
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
  const fTokenShieldInstance = shield[fromAddress]
    ? shield[fromAddress]
    : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShieldInstance.getFToken.call());
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
  const fTokenShieldInstance = shield[address] ? shield[address] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShieldInstance.getFToken.call());
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
  const fTokenShieldInstance = shield[address] ? shield[address] : await FTokenShield.deployed();
  const fToken = await FToken.at(await fTokenShieldInstance.getFToken.call());
  const symbol = await fToken.symbol.call();
  const name = await fToken.name.call();
  return { symbol, name };
}

/**
 * Mint a coin
 * @param {String} amount - the value of the coin
 * @param {String} ownerPublicKey - Alice's public key
 * @param {String} salt - Alice's token serial number as a hex string
 * @param {String} vkId
 * @param {Object} blockchainOptions
 * @param {String} blockchainOptions.fTokenShieldJson - ABI of fTokenShieldInstance
 * @param {String} blockchainOptions.fTokenShieldAddress - Address of deployed fTokenShieldContract
 * @param {String} blockchainOptions.account - Account that is sending these transactions
 * @returns {String} commitment - Commitment of the minted coins
 * @returns {Number} commitmentIndex
 */
async function mint(amount, _ownerPublicKey, _salt, vkId, blockchainOptions, zokratesOptions) {
  const { fTokenShieldJson, fTokenShieldAddress } = blockchainOptions;
  const account = utils.ensure0x(blockchainOptions.account);

  const {
    codePath,
    outputDirectory,
    witnessName = 'witness',
    pkPath,
    provingScheme = 'gm17',
    createProofJson = true,
    proofName = 'proof.json',
  } = zokratesOptions;

  const fTokenShield = contract(fTokenShieldJson);
  fTokenShield.setProvider(Web3.connect());
  const fTokenShieldInstance = await fTokenShield.at(fTokenShieldAddress);

  console.group('\nIN MINT...');

  // zero the most significant bits, just in case variables weren't supplied like that
  const ownerPublicKey = utils.zeroMSBs(_ownerPublicKey);
  const salt = utils.zeroMSBs(_salt);

  console.log('Finding the relevant Shield and Verifier contracts');
  const verifier = await Verifier.deployed();
  const verifierRegistry = await VerifierRegistry.deployed();
  console.log('FTokenShield contract address:', fTokenShieldInstance.address);
  console.log('Verifier contract address:', verifier.address);
  console.log('VerifierRegistry contract address:', verifierRegistry.address);

  // Calculate new arguments for the proof:
  console.log('AMOUNT', amount);
  const commitment = utils.zeroMSBs(utils.concatenateThenHash(amount, ownerPublicKey, salt));

  console.group('Existing Proof Variables:');
  const p = config.ZOKRATES_PACKING_SIZE;
  const pt = Math.ceil((config.INPUTS_HASHLENGTH * 8) / config.ZOKRATES_PACKING_SIZE); // packets in bits
  console.log('A: ', `${amount} : `, utils.hexToFieldPreserve(amount, p, 1));
  console.log('pkA: ', ownerPublicKey, ' : ', utils.hexToFieldPreserve(ownerPublicKey, p, pt));
  console.log('S_A: ', salt, ' : ', utils.hexToFieldPreserve(salt, p, pt));
  console.groupEnd();

  console.group('New Proof Variables:');
  console.log('zA: ', commitment, ' : ', utils.hexToFieldPreserve(commitment, p, pt));
  console.groupEnd();

  const publicInputHash = utils.zeroMSBs(utils.concatenateThenHash(amount, commitment));
  console.log('publicInputHash:', publicInputHash);

  const vectors = computeVectors([
    new Element(publicInputHash, 'field', 248, 1),
    new Element(amount, 'field', 128, 1),
    new Element(ownerPublicKey, 'field'),
    new Element(salt, 'field'),
    new Element(commitment, 'field'),
  ]);

  await zokrates.computeWitness(codePath, outputDirectory, witnessName, vectors);

  await zokrates.generateProof(pkPath, codePath, `${outputDirectory}/witness`, provingScheme, {
    createFile: createProofJson,
    directory: outputDirectory,
    fileName: proofName,
  });

  let { proof } = JSON.parse(fs.readFileSync(`${outputDirectory}/${proofName}`));

  proof = Object.values(proof);
  // convert to flattened array:
  proof = utils.flattenDeep(proof);
  // convert to decimal, as the solidity functions expect uints
  proof = proof.map(el => utils.hexToDec(el));
  console.groupEnd();

  // Approve fTokenShieldInstance to take tokens from minter's account.
  // TODO: Make this more generic, getContract will not be part of nightfall-sdk.
  const { contractInstance: fToken } = await getContract('FToken');
  await fToken.approve(fTokenShieldInstance.address, parseInt(amount, 16), {
    from: account,
    gas: 4000000,
    gasPrice: config.GASPRICE,
  });

  console.group('Minting within the Shield contract');

  const inputs = computeVectors([new Element(publicInputHash, 'field', 248, 1)]);

  console.log('proof:');
  console.log(proof);
  console.log('inputs:');
  console.log(inputs);
  console.log(`vkId: ${vkId}`);

  // Mint the commitment
  console.log('Approving ERC-20 spend from: ', fTokenShieldInstance.address);
  const txReceipt = await fTokenShieldInstance.mint(proof, inputs, vkId, amount, commitment, {
    from: account,
    gas: 6500000,
    gasPrice: config.GASPRICE,
  });
  console.log('ERC-20 spend approved!', parseInt(amount, 16));
  console.log('Balance of account', account, (await getBalance(account)).toNumber());

  const commitmentIndex = txReceipt.logs[0].args.commitment_index;

  const root = await fTokenShieldInstance.latestRoot();
  console.log(`Merkle Root after mint: ${root}`);
  console.groupEnd();

  console.log('Mint output: [zA, zAIndex]:', commitment, commitmentIndex.toString());
  console.log('MINT COMPLETE\n');
  console.groupEnd();
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
 * @param {String} blockchainOptions.fTokenShieldJson - ABI of fTokenShieldInstance
 * @param {String} blockchainOptions.fTokenShieldAddress - Address of deployed fTokenShieldContract
 * @param {String} blockchainOptions.account - Account that is sending these transactions
 * @returns {Object[]} outputCommitments - Updated outputCommitments with their commitments and indexes.
 * @returns {Object} Transaction object
 */
async function transfer(
  inputCommitments,
  outputCommitments,
  _receiverPublicKey,
  _senderSecretKey,
  vkId,
  blockchainOptions,
  zokratesOptions,
) {
  const { fTokenShieldJson, fTokenShieldAddress } = blockchainOptions;
  const account = utils.ensure0x(blockchainOptions.account);

  const {
    codePath,
    outputDirectory,
    witnessName = 'witness',
    pkPath,
    provingScheme = 'gm17',
    createProofJson = true,
    proofName = 'proof.json',
  } = zokratesOptions;

  const fTokenShield = contract(fTokenShieldJson);
  fTokenShield.setProvider(Web3.connect());
  const fTokenShieldInstance = await fTokenShield.at(fTokenShieldAddress);

  console.group('\nIN TRANSFER...');

  // zero the most significant bits, just in case variables weren't supplied like that
  for (const inputCommitment of inputCommitments) {
    inputCommitment.salt = utils.zeroMSBs(inputCommitment.salt);
    inputCommitment.commitment = utils.zeroMSBs(inputCommitment.commitment);
  }
  for (const outputCommitment of outputCommitments) {
    outputCommitment.salt = utils.zeroMSBs(outputCommitment.salt);
  }
  const senderSecretKey = utils.zeroMSBs(_senderSecretKey);
  const receiverPublicKey = utils.zeroMSBs(_receiverPublicKey);

  // due to limitations in the size of the adder implemented in the proof dsl,
  // we need C+D and E+F to easily fit in <128 bits (16 bytes). They could of course
  // be bigger than we allow here.
  const c = parseInt(inputCommitments[0].value, 16) + parseInt(inputCommitments[1].value, 16);
  const e = parseInt(outputCommitments[0].value, 16) + parseInt(outputCommitments[1].value, 16);
  if (c > 0xffffffff || e > 0xffffffff) throw new Error('Coin values are too large');

  console.log('Finding the relevant Shield and Verifier contracts');
  const verifier = await Verifier.deployed();
  const verifierRegistry = await VerifierRegistry.deployed();
  console.log('FTokenShield contract address:', fTokenShieldInstance.address);
  console.log('Verifier contract address:', verifier.address);
  console.log('VerifierRegistry contract address:', verifierRegistry.address);

  const root = await fTokenShieldInstance.latestRoot();
  console.log(`Merkle Root: ${root}`);

  // Calculate new arguments for the proof:
  const pkA = utils.zeroMSBs(utils.hash(senderSecretKey));
  const nC = utils.zeroMSBs(utils.concatenateThenHash(inputCommitments[0].salt, senderSecretKey));
  const nD = utils.zeroMSBs(utils.concatenateThenHash(inputCommitments[1].salt, senderSecretKey));
  const zE = utils.zeroMSBs(
    utils.concatenateThenHash(
      outputCommitments[0].value,
      receiverPublicKey,
      outputCommitments[0].salt,
    ),
  );
  const zF = utils.zeroMSBs(
    utils.concatenateThenHash(outputCommitments[1].value, pkA, outputCommitments[1].salt),
  );

  // we need the Merkle path from the token commitment to the root, expressed as Elements
  const pathC = await computePath(
    account,
    fTokenShieldInstance,
    inputCommitments[0].commitment,
    inputCommitments[0].index,
  );
  const pathD = await computePath(
    account,
    fTokenShieldInstance,
    inputCommitments[1].commitment,
    inputCommitments[1].index,
  );

  const pathCElements = {
    elements: pathC.path.map(
      element => new Element(element, 'field', config.MERKLE_HASHLENGTH * 8, 1),
    ), // we truncate to 216 bits - sending the whole 256 bits will overflow the prime field
    positions: new Element(pathC.positions, 'field', 128, 1),
  };

  const pathDElements = {
    elements: pathD.path.map(
      element => new Element(element, 'field', config.MERKLE_HASHLENGTH * 8, 1),
    ), // we truncate to 216 bits - sending the whole 256 bits will overflow the prime field
    positions: new Element(pathD.positions, 'field', 128, 1),
  };
  // console.log(`pathDlements.path:`, pathDElements.elements);
  // console.log(`pathDlements.positions:`, pathDElements.positions);

  // Although we only strictly need the root to be reconciled within zokrates, it's easier to check and intercept any errors in js; so we'll first try to reconcole here:
  checkRoot(inputCommitments[0].commitment, pathC, root);
  checkRoot(inputCommitments[1].commitment, pathD, root);

  console.group('Existing Proof Variables:');
  const p = config.ZOKRATES_PACKING_SIZE;
  console.log(
    `C: ${inputCommitments[0].value} : ${utils.hexToFieldPreserve(inputCommitments[0].value, p)}`,
  );
  console.log(
    `D: ${inputCommitments[1].value} : ${utils.hexToFieldPreserve(inputCommitments[1].value, p)}`,
  );
  console.log(
    `E: ${outputCommitments[0].value} : ${utils.hexToFieldPreserve(outputCommitments[0].value, p)}`,
  );
  console.log(
    `F: ${outputCommitments[1].value} : ${utils.hexToFieldPreserve(outputCommitments[1].value, p)}`,
  );
  console.log(`pkB: ${receiverPublicKey} : ${utils.hexToFieldPreserve(receiverPublicKey, p)}`);
  console.log(
    `S_C: ${inputCommitments[0].salt} : ${utils.hexToFieldPreserve(inputCommitments[0].salt, p)}`,
  );
  console.log(
    `S_D: ${inputCommitments[1].salt} : ${utils.hexToFieldPreserve(inputCommitments[1].salt, p)}`,
  );
  console.log(
    `S_E: ${outputCommitments[0].salt} : ${utils.hexToFieldPreserve(outputCommitments[0].salt, p)}`,
  );
  console.log(
    `S_F: ${outputCommitments[1].salt} : ${utils.hexToFieldPreserve(outputCommitments[1].salt, p)}`,
  );
  console.log(`skA: ${senderSecretKey} : ${utils.hexToFieldPreserve(senderSecretKey, p)}`);
  console.log(
    `zC: ${inputCommitments[0].commitment} : ${utils.hexToFieldPreserve(
      inputCommitments[0].commitment,
      p,
    )}`,
  );
  console.log(
    `zD: ${inputCommitments[1].commitment} : ${utils.hexToFieldPreserve(
      inputCommitments[1].commitment,
      p,
    )}`,
  );
  console.groupEnd();

  console.group('New Proof Variables:');
  console.log(`pkA: ${pkA} : ${utils.hexToFieldPreserve(pkA, p)}`);
  console.log(`nC: ${nC} : ${utils.hexToFieldPreserve(nC, p)}`);
  console.log(`nD: ${nD} : ${utils.hexToFieldPreserve(nD, p)}`);
  console.log(`zE: ${zE} : ${utils.hexToFieldPreserve(zE, p)}`);
  console.log(`zF: ${zF} : ${utils.hexToFieldPreserve(zF, p)}`);
  console.log(`root: ${root} : ${utils.hexToFieldPreserve(root, p)}`);
  console.groupEnd();

  const publicInputHash = utils.zeroMSBs(utils.concatenateThenHash(root, nC, nD, zE, zF));
  console.log('publicInputHash:', publicInputHash);

  // compute the proof
  console.log(
    'Computing proof with w=[C,D,E,F,S_C,S_D,S_E,S_F,pathC[], orderC,pathD[], orderD,skA,pkB]  x=[nC,nD,zE,zF,root,1]',
  );
  console.log(
    'vector order: [C,skA,S_C,pathC[0...31],orderC,D,S_D,pathD[0...31], orderD,nC,nD,E,pkB,S_E,zE,F,S_F,zF,root]',
  );

  const vectors = computeVectors([
    new Element(publicInputHash, 'field', 216, 1),
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
  ]);

  await zokrates.computeWitness(codePath, outputDirectory, witnessName, vectors);

  await zokrates.generateProof(pkPath, codePath, `${outputDirectory}/witness`, provingScheme, {
    createFile: createProofJson,
    directory: outputDirectory,
    fileName: proofName,
  });

  let { proof } = JSON.parse(fs.readFileSync(`${outputDirectory}/${proofName}`));

  proof = Object.values(proof);
  // convert to flattened array:
  proof = utils.flattenDeep(proof);
  // convert to decimal, as the solidity functions expect uints
  proof = proof.map(el => utils.hexToDec(el));
  console.groupEnd();

  console.group('Transferring within the Shield contract');

  const inputs = computeVectors([new Element(publicInputHash, 'field', 216, 1)]);

  console.log('proof:');
  console.log(proof);
  console.log('inputs:');
  console.log(inputs);

  console.log(`vkId: ${vkId}`);

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
  console.log(`Merkle Root after transfer: ${newRoot}`);
  console.groupEnd();

  const zEIndex = transferReceipt.logs[0].args.commitment1_index;
  const zFIndex = transferReceipt.logs[0].args.commitment2_index;

  console.log('TRANSFER COMPLETE\n');
  console.groupEnd();
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
This function is the simple batch equivalent of fungible transfer.  It takes a single
input coin and splits it between 20 recipients (some of which could be the original owner)
It's really the 'split' of a join-split.  It's no use for non-fungibles because, for them,
there's no concept of joining and splitting (yet).
@param {string} C - The value of the input coin C
@param {array} E - The values of the output coins (including the change coin)
@param {array} pkB - Bobs' public keys (must include at least one of pkA for change)
@param {string} S_C - Alice's salt
@param {array} S_E - Bobs' salts
@param {string} skA - Alice's private ('s'ecret) key
@param {string} zC - Alice's token commitment
@param {integer} zCIndex - the position of zC in the on-chain Merkle Tree
@param {string} account - the account that is paying for this
@returns {array} zE - The output token commitments
@returns {array} z_E_index - the indexes of the commitments within the Merkle Tree.  This is required for later transfers/joins so that Alice knows which leaf of the Merkle Tree she needs to get from the fTokenShieldInstance contract in order to calculate a path.
@returns {object} txObj - a promise of a blockchain transaction
*/
async function simpleFungibleBatchTransfer(
  inputCommitment,
  outputCommitments,
  receiversPublicKeys,
  senderSecretKey,
  vkId,
  blockchainOptions,
  zokratesOptions,
) {
  const { fTokenShieldJson, fTokenShieldAddress } = blockchainOptions;
  const account = utils.ensure0x(blockchainOptions.account);

  const {
    codePath,
    outputDirectory,
    witnessName = 'witness',
    pkPath,
    provingScheme = 'gm17',
    createProofJson = true,
    proofName = 'proof.json',
  } = zokratesOptions;

  const fTokenShield = contract(fTokenShieldJson);
  fTokenShield.setProvider(Web3.connect());
  const fTokenShieldInstance = await fTokenShield.at(fTokenShieldAddress);

  console.group('\nIN TRANSFER...');
  // firstly, we may have been passed hex strings longer than 216 bits.  That won't work
  // for our scheme so we need to zero out any leading zeros. (Ignore coins because they are 128 bits)
  const pkB = receiversPublicKeys.map(k => utils.zeroMSBs(k));
  const S_C = utils.zeroMSBs(inputCommitment.salt);
  const S_E = outputCommitments.map(k => utils.zeroMSBs(k.salt));
  const E = outputCommitments.map(k => k.value);
  const skA = utils.zeroMSBs(senderSecretKey);
  const zC = utils.zeroMSBs(inputCommitment.commitment);

  // check we have arrays of the correct length
  if (outputCommitments.length !== config.BATCH_PROOF_SIZE)
    throw new Error('Array E was the wrong length');
  if (pkB.length !== config.BATCH_PROOF_SIZE) throw new Error('Array pkB was the wrong length');
  if (S_E.length !== config.BATCH_PROOF_SIZE) throw new Error('Array S_E was the wrong length');

  // as BigInt is a better representation (up until now we've preferred hex strings),
  // we may get inputs passed as hex strings so let's do a conversion just in case

  // addition check
  const c = BigInt(inputCommitment.value);
  const T = E.reduce((acc, e) => acc + BigInt(e), BigInt(0));
  if (c !== T)
    throw new Error(
      `Input commitment value was ${inputCommitment.value} but output total was ${T}`,
    );

  console.log('Finding the relevant Shield and Verifier contracts');
  const verifier = await Verifier.deployed();
  const verifierRegistry = await VerifierRegistry.deployed();
  console.log('FTokenShield contract address:', fTokenShieldInstance.address);
  console.log('Verifier contract address:', verifier.address);
  console.log('VerifierRegistry contract address:', verifierRegistry.address);

  const root = await fTokenShieldInstance.latestRoot();
  console.log(`Merkle Root: ${root}`);

  // Calculate new arguments for the proof:
  const nC = utils.zeroMSBs(utils.concatenateThenHash(S_C, skA));
  const zE = [];
  for (let i = 0; i < E.length; i++) {
    zE[i] = utils.zeroMSBs(utils.concatenateThenHash(E[i], pkB[i], S_E[i]));
  }
  // we need the Merkle path from the token commitment to the root, expressed as Elements
  const pathC = await computePath(account, fTokenShieldInstance, zC, inputCommitment.index);
  const pathCElements = {
    elements: pathC.path.map(
      element => new Element(element, 'field', config.MERKLE_HASHLENGTH * 8, 1),
    ), // we truncate to 216 bits - sending the whole 256 bits will overflow the prime field
    positions: new Element(pathC.positions, 'field', 128, 1),
  };

  // Although we only strictly need the root to be reconciled within zokrates, it's easier to check and intercept any errors in js; so we'll first try to reconcole here:
  checkRoot(zC, pathC, root); // this function currently needs hex rather than BigInt
  const publicInputHash = utils.zeroMSBs(utils.concatenateThenHash(root, nC, ...zE));
  console.log('publicInputHash:', publicInputHash);

  const inputs = computeVectors([new Element(publicInputHash, 'field', 216, 1)]);
  console.log('inputs:');
  console.log(inputs);

  // get the pwd so we can talk to the container:
  const pwd = process.env.PWD.toString();
  console.log(pwd);

  const hostDir = config.FT_SIMPLE_BATCH_TRANSFER_DIR;
  console.log(hostDir);

  // compute the proof
  console.log(
    'Computing proof with w=[C,D,E,F,S_C,S_D,S_E,S_F,pathC[], orderC,pathD[], orderD,skA,pkB]  x=[nC,nD,zE,zF,root,1]',
  );
  console.log(
    'vector order: [C,skA,S_C,pathC[0...31],orderC,D,S_D,pathD[0...31], orderD,nC,nD,E,pkB,S_E,zE,F,S_F,zF,root]',
  );
  const vectors = computeVectors([
    new Element(publicInputHash, 'field', 216, 1),
    new Element(inputCommitment.value, 'field', 128, 1),
    new Element(skA, 'field', 216, 1),
    new Element(S_C, 'field', 216, 1),
    ...pathCElements.elements.slice(1),
    pathCElements.positions,
    new Element(nC, 'field', 216, 1),
    ...E.map(e => new Element(e, 'field', 128, 1)),
    ...pkB.map(pkb => new Element(pkb, 'field', 216, 1)),
    ...S_E.map(se => new Element(se, 'field', 216, 1)),
    ...zE.map(ze => new Element(ze, 'field', 216, 1)),
    new Element(root, 'field', 216, 1),
  ]);

  await zokrates.computeWitness(codePath, outputDirectory, witnessName, vectors);

  await zokrates.generateProof(pkPath, codePath, `${outputDirectory}/witness`, provingScheme, {
    createFile: createProofJson,
    directory: outputDirectory,
    fileName: proofName,
  });

  let { proof } = JSON.parse(fs.readFileSync(`${outputDirectory}/${proofName}`));

  proof = Object.values(proof);
  // convert to flattened array:
  proof = utils.flattenDeep(proof);
  // convert to decimal, as the solidity functions expect uints
  proof = proof.map(el => utils.hexToDec(el));
  console.groupEnd();

  // send the token to Bob by transforming the commitment
  const transferReceipt = await fTokenShieldInstance.simpleBatchTransfer(
    proof,
    inputs,
    vkId,
    root,
    nC,
    zE,
    {
      from: account,
      gas: 6500000,
      gasPrice: config.GASPRICE,
    },
  );

  const newRoot = await fTokenShieldInstance.latestRoot();
  console.log(`Merkle Root after transfer: ${newRoot}`);
  console.groupEnd();

  const zEIndex = transferReceipt.logs[0].args.commitment_index;

  console.log('TRANSFER COMPLETE\n');
  console.groupEnd();
  return {
    z_E: zE,
    z_E_index: zEIndex,
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
 * @param {String} blockchainOptions.fTokenShieldJson - ABI of fTokenShieldInstance
 * @param {String} blockchainOptions.fTokenShieldAddress - Address of deployed fTokenShieldContract
 * @param {String} blockchainOptions.account - Account that is sending these transactions
 * @param {String} blockchainOptions.tokenReceiver - Account that will receive the tokens
 */
async function burn(
  amount,
  _receiverSecretKey,
  _salt,
  _commitment,
  commitmentIndex,
  vkId,
  blockchainOptions,
  zokratesOptions,
) {
  // zero the most significant bits, just in case variables weren't supplied like that
  const salt = utils.zeroMSBs(_salt);
  const commitment = utils.zeroMSBs(_commitment);
  const receiverSecretKey = utils.zeroMSBs(_receiverSecretKey);

  const { fTokenShieldJson, fTokenShieldAddress, tokenReceiver: _payTo } = blockchainOptions;

  const account = utils.ensure0x(blockchainOptions.account);

  const {
    codePath,
    outputDirectory,
    witnessName = 'witness',
    pkPath,
    provingScheme = 'gm17',
    createProofJson = true,
    proofName = 'proof.json',
  } = zokratesOptions;

  const fTokenShield = contract(fTokenShieldJson);
  fTokenShield.setProvider(Web3.connect());
  const fTokenShieldInstance = await fTokenShield.at(fTokenShieldAddress);

  let payTo = _payTo;
  if (payTo === undefined) payTo = account; // have the option to pay out to another address
  // before we can burn, we need to deploy a verifying key to mintVerifier (reusing mint for this)
  console.group('\nIN BURN...');

  console.log('Finding the relevant Shield and Verifier contracts');
  const verifier = await Verifier.deployed();
  const verifierRegistry = await VerifierRegistry.deployed();
  console.log('FTokenShield contract address:', fTokenShieldInstance.address);
  console.log('Verifier contract address:', verifier.address);
  console.log('VerifierRegistry contract address:', verifierRegistry.address);

  const root = await fTokenShieldInstance.latestRoot(); // solidity getter for the public variable latestRoot
  console.log(`Merkle Root: ${root}`);

  // Calculate new arguments for the proof:
  const Nc = utils.zeroMSBs(utils.concatenateThenHash(salt, receiverSecretKey));
  // We need the Merkle path from the commitment to the root, expressed as Elements
  const path = await computePath(account, fTokenShieldInstance, commitment, commitmentIndex);
  const pathElements = {
    elements: path.path.map(
      element => new Element(element, 'field', config.MERKLE_HASHLENGTH * 8, 1),
    ), // We can fit the 216 bit hash into a single field - more compact
    positions: new Element(path.positions, 'field', 128, 1),
  };
  // console.log(`pathElements.path:`, pathElements.elements);
  // console.log(`pathElements.positions:`, pathElements.positions);

  // Although we only strictly need the root to be reconciled within zokrates, it's easier to check and intercept any errors in js; so we'll first try to reconcole here:
  checkRoot(commitment, path, root);

  // Summarise values in the console:
  console.group('Existing Proof Variables:');
  const p = config.ZOKRATES_PACKING_SIZE;
  console.log(`C: ${amount} : ${utils.hexToFieldPreserve(amount, p)}`);
  console.log(`skA: ${receiverSecretKey} : ${utils.hexToFieldPreserve(receiverSecretKey, p)}`);
  console.log(`S_C: ${salt} : ${utils.hexToFieldPreserve(salt, p)}`);
  console.log(`payTo: ${payTo} : ${utils.hexToFieldPreserve(payTo, p)}`);
  const payToLeftPadded = utils.leftPadHex(payTo, config.INPUTS_HASHLENGTH * 2); // left-pad the payToAddress with 0's to fill all 256 bits (64 octets) (so the sha256 function is hashing the same thing as inside the zokrates proof)
  console.log(`payToLeftPadded: ${payToLeftPadded}`);
  console.groupEnd();

  console.group('New Proof Variables:');
  console.log(`Nc: ${Nc} : ${utils.hexToFieldPreserve(Nc, p)}`);
  console.log(`zC: ${commitment} : ${utils.hexToFieldPreserve(commitment, p)}`);
  console.log(`root: ${root} : ${utils.hexToFieldPreserve(root, p)}`);
  console.groupEnd();

  const publicInputHash = utils.concatenateThenHash(root, Nc, amount, payToLeftPadded); // notice we're using the version of payTo which has been padded to 256-bits; to match our derivation of publicInputHash within our zokrates proof.
  console.log('publicInputHash:', publicInputHash);

  // compute the proof
  console.group('Computing proof with w=[skA,S_C,path[],order] x=[C,Nc,root,1]');

  const vectors = computeVectors([
    new Element(publicInputHash, 'field', 216, 1),
    new Element(payTo, 'field'),
    new Element(amount, 'field', 128, 1),
    new Element(receiverSecretKey, 'field'),
    new Element(salt, 'field'),
    ...pathElements.elements.slice(1),
    pathElements.positions,
    new Element(Nc, 'field'),
    new Element(root, 'field'),
  ]);

  await zokrates.computeWitness(codePath, outputDirectory, witnessName, vectors);

  await zokrates.generateProof(pkPath, codePath, `${outputDirectory}/witness`, provingScheme, {
    createFile: createProofJson,
    directory: outputDirectory,
    fileName: proofName,
  });

  let { proof } = JSON.parse(fs.readFileSync(`${outputDirectory}/${proofName}`));

  proof = Object.values(proof);
  // convert to flattened array:
  proof = utils.flattenDeep(proof);
  // convert to decimal, as the solidity functions expect uints
  proof = proof.map(el => utils.hexToDec(el));
  console.groupEnd();

  console.group('Burning within the Shield contract');

  const inputs = computeVectors([new Element(publicInputHash, 'field', 216, 1)]);

  console.log('proof:');
  console.log(proof);
  console.log('inputs:');
  console.log(inputs);
  console.log(`vkId: ${vkId}`);

  // Burn the commitment and return tokens to the payTo account.
  await fTokenShieldInstance.burn(proof, inputs, vkId, root, Nc, amount, payTo, {
    from: account,
    gas: 6500000,
    gasPrice: config.GASPRICE,
  });

  const newRoot = await fTokenShieldInstance.latestRoot();
  console.log(`Merkle Root after burn: ${newRoot}`);
  console.groupEnd();

  console.log('BURN COMPLETE\n');
  console.groupEnd();
  return { z_C: commitment, z_C_index: commitmentIndex };
}

async function checkCorrectness(C, pk, S, z, zIndex, account) {
  const fTokenShieldInstance = shield[account] ? shield[account] : await FTokenShield.deployed();

  const results = await zkp.checkCorrectness(C, pk, S, z, zIndex, fTokenShieldInstance);
  console.log('\nf-token-controller', '\ncheckCorrectness', '\nresults', results);

  return results;
}

export default {
  burn,
  transfer,
  simpleFungibleBatchTransfer,
  mint,
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
