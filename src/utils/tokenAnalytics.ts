import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../services/logger';
import { cache } from '../services/cache';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { fetchHistoricalVolume } from '../api/onchain';

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const ETHERSCAN_API = 'https://api.etherscan.io/api';

export interface TokenMetrics {
  marketCap: number;
  fullyDilutedValuation: number;
  volumeMarketCapRatio: number;
  circulatingSupplyPercentage: number;
  isVolumeHealthy: boolean;
  isCirculatingSupplyGood: boolean;
  potentialMultiplier: number;
  walletDistributionScore: number;
  pumpDumpRiskScore: number;
}

interface TokenInput {
  price?: number;
  marketCap?: number;
  volume24h?: number;
  transferVolume24h?: number;
  circulatingSupply?: number;
  totalSupply?: number;
  targetMarketCap?: number;
  coingeckoId?: string;
  contractAddress?: string;
  platform?: string;
  symbol?: string;
  txActivityScore?: number;
}

export async function calculateWalletDistributionScore(token: TokenInput): Promise<number> {
  if (!token.contractAddress || !token.platform) {
    logger.warn(`Missing contractAddress or platform for wallet distribution score: contractAddress=${token.contractAddress}, platform=${token.platform}`);
    return 0;
  }

  const cacheKey = `holders_${token.contractAddress}_${token.platform}`;
  const cachedScore = cache.get<number>(cacheKey);
  if (cachedScore !== null) {
    logger.info(`Using cached wallet distribution score for ${token.contractAddress}: ${cachedScore}`);
    return cachedScore;
  }

  try {
    let top10Holdings = 0;
    let totalSupply = token.totalSupply || 1e9;

    logger.debug(`Calculating wallet distribution for ${token.contractAddress} on ${token.platform}, totalSupply=${totalSupply}`);

    if (token.platform === 'ethereum') {
      const response = await axios.get(ETHERSCAN_API, {
        params: {
          module: 'account',
          action: 'tokentx',
          contractaddress: token.contractAddress,
          page: 1,
          offset: 100,
          sort: 'desc',
          apikey: process.env.ETHERSCAN_API_KEY || '',
        },
        timeout: 5000,
      });

      if (response.data.status !== '1') {
        logger.warn(`Etherscan API error for ${token.contractAddress}: ${response.data.message}`);
        return 0;
      }

      const transfers = response.data.result;
      if (!transfers || transfers.length === 0) {
        logger.warn(`No transfers found for ${token.contractAddress} on Ethereum`);
        return 0;
      }

      const uniqueHolders = new Set<string>();
      let totalTransferred = 0;
      for (const tx of transfers) {
        uniqueHolders.add(tx.from);
        uniqueHolders.add(tx.to);
        totalTransferred += parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal || '18'));
      }
      top10Holdings = totalTransferred * 0.5; // Assume top 10 hold 50% of transferred volume
      logger.debug(`Ethereum: ${token.contractAddress}, transfers=${transfers.length}, uniqueHolders=${uniqueHolders.size}, top10Holdings=${top10Holdings}`);

      const supplyResponse = await axios.get(ETHERSCAN_API, {
        params: {
          module: 'stats',
          action: 'tokensupply',
          contractaddress: token.contractAddress,
          apikey: process.env.ETHERSCAN_API_KEY || '',
        },
        timeout: 5000,
      });
      if (supplyResponse.data.status === '1' && supplyResponse.data.result) {
        totalSupply = parseFloat(supplyResponse.data.result) / 1e18 || totalSupply;
        logger.debug(`Ethereum: Updated totalSupply for ${token.contractAddress} to ${totalSupply}`);
      } else {
        logger.warn(`Etherscan tokensupply error for ${token.contractAddress}: ${supplyResponse.data.message}`);
      }
    } else if (token.platform === 'solana') {
      const connection = new Connection(SOLANA_RPC, 'confirmed');
      const mintPubkey = new PublicKey(token.contractAddress);
      const accounts = await connection.getTokenLargestAccounts(mintPubkey);
      if (!accounts.value || accounts.value.length === 0) {
        logger.warn(`No accounts found for ${token.contractAddress} on Solana`);
        return 0;
      }
      top10Holdings = accounts.value
        .slice(0, 10)
        .reduce((sum: number, acc: { amount: string }) => sum + parseFloat(acc.amount), 0);
      logger.debug(`Solana: ${token.contractAddress}, top10Holdings=${top10Holdings}`);

      const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
      if (
        mintInfo.value &&
        typeof mintInfo.value.data === 'object' &&
        'parsed' in mintInfo.value.data
      ) {
        totalSupply = parseFloat((mintInfo.value.data as any).parsed.info.supply) || totalSupply;
        logger.debug(`Solana: Updated totalSupply for ${token.contractAddress} to ${totalSupply}`);
      } else {
        logger.warn(`Solana mint info error for ${token.contractAddress}`);
      }
    }

    if (totalSupply === 0) {
      logger.warn(`Total supply is 0 for ${token.contractAddress}, using fallback: 1e9`);
      totalSupply = 1e9;
    }

    const top10Percentage = top10Holdings / totalSupply;
    const score = 100 - top10Percentage * 100;
    const finalScore = Math.min(Math.max(score, 0), 100);
    cache.set(cacheKey, finalScore, 86400);
    logger.info(`Calculated wallet distribution score for ${token.contractAddress} (${token.platform}): ${finalScore}, top10Percentage=${top10Percentage}`);
    return finalScore;
  } catch (error: any) {
    logger.error(`Error calculating wallet distribution score for ${token.contractAddress} (${token.platform}): ${error.message}`);
    return 0;
  }
}

async function calculatePumpDumpRiskScore(
  token: TokenInput,
  volumeMarketCapRatio: number,
  walletDistributionScore: number
): Promise<number> {
  const { transferVolume24h, txActivityScore, symbol, coingeckoId } = token;

  const historicalSymbol = symbol || coingeckoId || 'unknown';
  if (!symbol) {
    logger.warn(`Missing symbol for pump-dump risk score, using fallback: ${historicalSymbol}`);
  }

  const historicalVolume = await fetchHistoricalVolume(historicalSymbol);
  const volumeSpike = transferVolume24h && historicalVolume
    ? transferVolume24h / (historicalVolume || 1)
    : 1;
  const volumeRisk = volumeMarketCapRatio > 0.5 ? 30 : volumeMarketCapRatio > 0.2 ? 20 : 10;
  const distributionRisk = walletDistributionScore < 50 ? 30 : walletDistributionScore < 80 ? 20 : 10;
  const txActivityRisk = txActivityScore && txActivityScore > 80 ? 30 : txActivityScore && txActivityScore > 50 ? 20 : 10;
  const spikeRisk = volumeSpike > 5 ? 30 : volumeSpike > 2 ? 20 : 10;

  const score = (volumeRisk * 0.3) + (distributionRisk * 0.3) + (txActivityRisk * 0.2) + (spikeRisk * 0.2);
  const finalScore = Math.min(Math.max(score, 0), 100);

  logger.info(`Pump-dump risk score for ${historicalSymbol}: ${finalScore} (volume: ${volumeRisk}, dist: ${distributionRisk}, tx: ${txActivityRisk}, spike: ${spikeRisk})`);
  return finalScore;
}

export async function calculateTokenMetrics(token: TokenInput): Promise<TokenMetrics> {
  const volumeMarketCapRatio = token.marketCap && token.volume24h && token.marketCap > 0
    ? token.volume24h / token.marketCap
    : 0;
  const circulatingSupplyPercentage =
    token.circulatingSupply && token.totalSupply && token.totalSupply > 0
      ? (token.circulatingSupply / token.totalSupply) * 100
      : 0;
  const potentialMultiplier =
    token.targetMarketCap && token.marketCap && token.marketCap > 0
      ? token.targetMarketCap / token.marketCap
      : 0;
  const fullyDilutedValuation = token.price && token.totalSupply
    ? token.price * token.totalSupply
    : 0;

  const walletDistributionScore = await calculateWalletDistributionScore(token);
  const pumpDumpRiskScore = await calculatePumpDumpRiskScore(token, volumeMarketCapRatio, walletDistributionScore);

  return {
    marketCap: token.marketCap || 0,
    fullyDilutedValuation,
    volumeMarketCapRatio,
    circulatingSupplyPercentage,
    isVolumeHealthy: volumeMarketCapRatio > 0.1,
    isCirculatingSupplyGood: circulatingSupplyPercentage > 50,
    potentialMultiplier,
    walletDistributionScore,
    pumpDumpRiskScore,
  };
}