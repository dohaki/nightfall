/* eslint-disable camelcase */

import { Router } from 'express';
import utils from '../zkpUtils';
import fTokenController from '../f-token-controller';
import { getVkId, getContract } from '../contractUtils';

const router = Router();

async function mint(req, res, next) {
  const { address } = req.headers;
  const { amount, ownerPublicKey } = req.body;
  const salt = await utils.rndHex(32);
  const vkId = await getVkId('MintCoin');
  const { contractJson: fTokenShieldJson, contractInstance: fTokenShield } = await getContract(
    'FTokenShield',
  );

  try {
    const { commitment, commitmentIndex } = await fTokenController.mint(
      amount,
      ownerPublicKey,
      salt,
      vkId,
      {
        fTokenShieldJson,
        fTokenShieldAddress: fTokenShield.address,
        account: address,
      },
    );
    res.data = {
      coin: commitment,
      coin_index: commitmentIndex,
      S_A: salt,
    };
    next();
  } catch (err) {
    next(err);
  }
}

async function transfer(req, res, next) {
  const { address } = req.headers;
  const {
    C,
    D,
    E,
    F,
    pk_B: receiverPublicKey,
    S_C,
    S_D,
    sk_A: senderSecretKey,
    z_C,
    z_C_index,
    z_D,
    z_D_index,
  } = req.body;
  const vkId = await getVkId('TransferCoin');
  const { contractJson: fTokenShieldJson, contractInstance: fTokenShield } = await getContract(
    'FTokenShield',
  );

  const inputCommitments = [
    {
      value: C,
      salt: S_C,
      commitment: z_C,
      index: z_C_index,
    },
    {
      value: D,
      salt: S_D,
      commitment: z_D,
      index: z_D_index,
    },
  ];

  const outputCommitments = [
    {
      value: E,
      salt: await utils.rndHex(32),
    },
    {
      value: F,
      salt: await utils.rndHex(32),
    },
  ];

  try {
    const {
      outputCommitments: returnedOutputCommitments,
      transferReceipt,
    } = await fTokenController.transfer(
      inputCommitments,
      outputCommitments,
      receiverPublicKey,
      senderSecretKey,
      vkId,
      {
        fTokenShieldJson,
        fTokenShieldAddress: fTokenShield.address,
        account: address,
      },
    );
    res.data = {
      z_E: returnedOutputCommitments[0].commitment,
      z_E_index: returnedOutputCommitments[0].index,
      z_F: returnedOutputCommitments[1].commitment,
      z_F_index: returnedOutputCommitments[1].index,
      S_E: returnedOutputCommitments[0].salt,
      S_F: returnedOutputCommitments[1].salt,
      txObj: transferReceipt,
    };
    next();
  } catch (err) {
    next(err);
  }
}

async function burn(req, res, next) {
  const { amount, receiverSecretKey, salt, commitment, commitmentIndex, tokenReceiver } = req.body;
  const { address } = req.headers;
  const vkId = await getVkId('BurnCoin');
  const { contractJson: fTokenShieldJson, contractInstance: fTokenShield } = await getContract(
    'FTokenShield',
  );

  try {
    await fTokenController.burn(
      amount,
      receiverSecretKey,
      salt,
      commitment,
      commitmentIndex,
      vkId,
      {
        fTokenShieldJson,
        fTokenShieldAddress: fTokenShield.address,
        account: address,
        tokenReceiver,
      },
    );
    res.data = {
      z_C: commitment,
      z_C_index: commitmentIndex,
    };
    next();
  } catch (err) {
    next(err);
  }
}

async function checkCorrectness(req, res, next) {
  console.log('\nzkp/src/restapi', '\n/checkCorrectnessForFTCommitment', '\nreq.body', req.body);

  try {
    const { address } = req.headers;
    const {
      E: value,
      pk: publicKey,
      S_E: salt,
      z_E: commitment,
      z_E_index: commitmentIndex,
    } = req.body;

    const results = await fTokenController.checkCorrectness(
      value,
      publicKey,
      salt,
      commitment,
      commitmentIndex,
      address,
    );
    console.log('\nzkp/src/restapi', '\n/coin/checkCorrectness', '\nresults', results);

    res.data = results;
    next();
  } catch (err) {
    next(err);
  }
}

async function setCoinShieldAddress(req, res, next) {
  const { address } = req.headers;
  const { coinShield } = req.body;

  try {
    await fTokenController.setShield(coinShield, address);
    await fTokenController.getBalance(address);
    res.data = {
      message: 'CoinShield Address Set.',
    };
    next();
  } catch (err) {
    next(err);
  }
}

async function getCoinShieldAddress(req, res, next) {
  const { address } = req.headers;

  try {
    const shieldAddress = await fTokenController.getShieldAddress(address);
    const { name } = await fTokenController.getTokenInfo(address);
    res.data = {
      shieldAddress,
      name,
    };
    next();
  } catch (err) {
    next(err);
  }
}

async function unsetCoinShieldAddress(req, res, next) {
  const { address } = req.headers;

  try {
    fTokenController.unSetShield(address);
    res.data = {
      message: 'CoinShield Address Unset.',
    };
    next();
  } catch (err) {
    next(err);
  }
}

router.post('/mintFTCommitment', mint);
router.post('/transferFTCommitment', transfer);
router.post('/burnFTCommitment', burn);
router.post('/checkCorrectnessForFTCommitment', checkCorrectness);
router.post('/setFTokenShieldContractAddress', setCoinShieldAddress);
router.get('/getFTokenShieldContractAddress', getCoinShieldAddress);
router.delete('/removeFTCommitmentshield', unsetCoinShieldAddress);

export default router;
