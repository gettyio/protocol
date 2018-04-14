/*global artifacts*/

const chai = require('chai');
const expect = chai.expect;
chai.use(require('chai-bignumber')());

const BigNumber = require('bignumber.js');

const InterestImpl = artifacts.require("InterestImpl");
const TestInterestImpl = artifacts.require("TestInterestImpl");
const Vault = artifacts.require("Vault");
const QuoteToken = artifacts.require("TokenA");
const BaseToken = artifacts.require("TokenB");
const FeeToken = artifacts.require("TokenC");
const { getPartialAmount } = require('../helpers/MathHelper');
const { getBlockTimestamp } = require('./NodeHelper');
const { getMaxInterestFee } = require('./MarginHelper');

module.exports = {
  checkSuccess,
  checkSmartContractBalances,
  checkLenderBalances,
  getOwedAmount,
  getBalances,
  checkSuccessCloseDirectly,
  getPositionLifetime
};

async function checkSuccess(dydxMargin, OpenTx, closeTx, sellOrder, closeAmount) {
  const baseTokenOwedToLender = await getOwedAmount(OpenTx, closeTx, closeAmount);
  const quoteTokenFromSell = getPartialAmount(
    OpenTx.buyOrder.makerTokenAmount,
    OpenTx.buyOrder.takerTokenAmount,
    closeAmount
  );
  const quoteTokenBuybackCost = getPartialAmount(
    sellOrder.takerTokenAmount,
    sellOrder.makerTokenAmount,
    baseTokenOwedToLender
  );

  const balances = await getBalances(dydxMargin, OpenTx, sellOrder);
  const {
    traderQuoteToken,
    externalEntityQuoteToken,
    externalEntityBaseToken,
    traderFeeToken,
    externalEntityFeeToken,
    feeRecipientFeeToken
  } = balances;

  checkSmartContractBalances(balances, OpenTx, closeAmount);
  checkLenderBalances(balances, baseTokenOwedToLender, OpenTx);

  expect(traderQuoteToken).to.be.bignumber.equal(
    getPartialAmount(
      closeAmount,
      OpenTx.principal,
      OpenTx.depositAmount
    ).plus(quoteTokenFromSell)
      .minus(quoteTokenBuybackCost)
  );
  expect(externalEntityQuoteToken).to.be.bignumber.equal(quoteTokenBuybackCost);
  expect(externalEntityBaseToken).to.be.bignumber.equal(
    sellOrder.makerTokenAmount.minus(baseTokenOwedToLender)
  );
  expect(feeRecipientFeeToken).to.be.bignumber.equal(
    getPartialAmount(
      baseTokenOwedToLender,
      sellOrder.makerTokenAmount,
      sellOrder.takerFee
    ).plus(
      getPartialAmount(
        baseTokenOwedToLender,
        sellOrder.makerTokenAmount,
        sellOrder.makerFee
      )
    )
  );
  expect(traderFeeToken).to.be.bignumber.equal(
    OpenTx.buyOrder.takerFee
      .plus(OpenTx.loanOffering.rates.takerFee)
      .plus(sellOrder.takerFee)
      .minus(
        getPartialAmount(
          OpenTx.principal,
          OpenTx.loanOffering.rates.maxAmount,
          OpenTx.loanOffering.rates.takerFee
        )
      )
      .minus(
        getPartialAmount(
          OpenTx.principal,
          OpenTx.buyOrder.takerTokenAmount,
          OpenTx.buyOrder.takerFee
        )
      )
      .minus(
        getPartialAmount(
          baseTokenOwedToLender,
          sellOrder.makerTokenAmount,
          sellOrder.takerFee
        )
      )
  );
  expect(externalEntityFeeToken).to.be.bignumber.equal(
    sellOrder.makerFee
      .minus(
        getPartialAmount(
          baseTokenOwedToLender,
          sellOrder.makerTokenAmount,
          sellOrder.makerFee
        )
      )
  );
}

function checkSmartContractBalances(balances, OpenTx, closeAmount) {
  const startingQuoteTokenAmount = getPartialAmount(
    OpenTx.buyOrder.makerTokenAmount,
    OpenTx.buyOrder.takerTokenAmount,
    OpenTx.principal
  ).plus(OpenTx.depositAmount);
  const expectedBalance = getPartialAmount(
    OpenTx.principal.minus(closeAmount),
    OpenTx.principal,
    startingQuoteTokenAmount
  );

  const {
    vaultFeeToken,
    vaultQuoteToken,
    vaultBaseToken,
    positionBalance
  } = balances;

  expect(vaultFeeToken).to.be.bignumber.equal(0);
  expect(vaultQuoteToken).to.be.bignumber.equal(expectedBalance);
  expect(vaultBaseToken).to.be.bignumber.equal(0);
  expect(positionBalance).to.be.bignumber.equal(expectedBalance);
}

function checkLenderBalances(balances, baseTokenOwedToLender, OpenTx) {
  const {
    lenderQuoteToken,
    lenderBaseToken,
  } = balances;
  expect(lenderQuoteToken).to.be.bignumber.equal(0);
  expect(lenderBaseToken).to.be.bignumber.equal(
    OpenTx.loanOffering.rates.maxAmount
      .minus(OpenTx.principal)
      .plus(baseTokenOwedToLender));
}

async function getOwedAmount(OpenTx, closeTx, closeAmount, roundUpToPeriod = true) {
  let positionLifetime = await getPositionLifetime(OpenTx, closeTx);
  let interestPeriod = OpenTx.loanOffering.rates.interestPeriod;
  if (interestPeriod.gt(1)) {
    positionLifetime = getPartialAmount(
      positionLifetime, interestPeriod, 1, roundUpToPeriod).times(interestPeriod);
  }

  await TestInterestImpl.link('InterestImpl', InterestImpl.address);
  const interestCalc = await TestInterestImpl.new();

  const getOwedAmount = await interestCalc.getCompoundedInterest.call(
    closeAmount,
    OpenTx.loanOffering.rates.interestRate,
    positionLifetime
  );
  return getOwedAmount;
}

async function getBalances(dydxMargin, OpenTx, sellOrder) {
  const [
    baseToken,
    quoteToken,
    feeToken
  ] = await Promise.all([
    BaseToken.deployed(),
    QuoteToken.deployed(),
    FeeToken.deployed(),
  ]);

  let externalEntityQuoteToken,
    externalEntityBaseToken,
    externalEntityFeeToken,
    feeRecipientFeeToken;

  if (sellOrder) {
    [
      externalEntityQuoteToken,
      externalEntityBaseToken,
      externalEntityFeeToken,
      feeRecipientFeeToken,
    ] = await Promise.all([
      quoteToken.balanceOf.call(sellOrder.maker),
      baseToken.balanceOf.call(sellOrder.maker),
      feeToken.balanceOf.call(sellOrder.maker),
      feeToken.balanceOf.call(sellOrder.feeRecipient),
    ]);
  }

  const [
    traderQuoteToken,
    traderBaseToken,

    lenderQuoteToken,
    lenderBaseToken,

    traderFeeToken,

    vaultFeeToken,
    vaultQuoteToken,
    vaultBaseToken,

    positionBalance
  ] = await Promise.all([
    quoteToken.balanceOf.call(OpenTx.trader),
    baseToken.balanceOf.call(OpenTx.trader),

    quoteToken.balanceOf.call(OpenTx.loanOffering.payer),
    baseToken.balanceOf.call(OpenTx.loanOffering.payer),

    feeToken.balanceOf.call(OpenTx.trader),

    feeToken.balanceOf.call(Vault.address),
    quoteToken.balanceOf.call(Vault.address),
    baseToken.balanceOf.call(Vault.address),

    dydxMargin.getPositionBalance.call(OpenTx.id)
  ]);

  return {
    traderQuoteToken,
    traderBaseToken,

    lenderQuoteToken,
    lenderBaseToken,

    externalEntityQuoteToken,
    externalEntityBaseToken,
    externalEntityFeeToken,
    traderFeeToken,

    feeRecipientFeeToken,

    vaultFeeToken,
    vaultQuoteToken,
    vaultBaseToken,

    positionBalance
  };
}

async function checkSuccessCloseDirectly(dydxMargin, OpenTx, closeTx, closeAmount) {
  const baseTokenOwedToLender = await getOwedAmount(OpenTx, closeTx, closeAmount);
  const balances = await getBalances(dydxMargin, OpenTx);
  const quoteTokenFromSell = getPartialAmount(
    OpenTx.buyOrder.makerTokenAmount,
    OpenTx.buyOrder.takerTokenAmount,
    closeAmount
  );

  checkSmartContractBalances(balances, OpenTx, closeAmount);
  checkLenderBalances(balances, baseTokenOwedToLender, OpenTx);
  const maxInterest = await getMaxInterestFee(OpenTx);
  expect(balances.traderBaseToken).to.be.bignumber.equal(
    OpenTx.principal
      .plus(maxInterest)
      .minus(baseTokenOwedToLender)
  );

  expect(balances.traderQuoteToken).to.be.bignumber.equal(
    getPartialAmount(
      closeAmount,
      OpenTx.principal,
      OpenTx.depositAmount
    )
      .plus(quoteTokenFromSell)
  );
}

async function getPositionLifetime(OpenTx, tx) {
  const [positionTimestamp, positionClosedTimestamp] = await Promise.all([
    getBlockTimestamp(OpenTx.response.receipt.blockNumber),
    getBlockTimestamp(tx.receipt.blockNumber)
  ]);
  const maxDuration = OpenTx.loanOffering.maxDuration;
  let duration = positionClosedTimestamp - positionTimestamp;
  if (duration > maxDuration) {
    duration = maxDuration;
  }
  return new BigNumber(duration);
}
