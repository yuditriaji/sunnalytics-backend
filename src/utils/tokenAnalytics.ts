import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../services/logger';
import { cache } from '../services/cache';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

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
}

interface TokenInput {
  price: number;
  marketCap: number;
  volume24h: number;
  transferVolume24h?: number;
  circulatingSupply?: number;
  totalSupply?: number;
  targetMarketCap?: number;
  coingeckoId?: string;
  contractAddress?: string;
  platform?: string;
}

async function calculateWalletDistributionScore(token: TokenInput): Promise<number> {
  if (!token.contractAddress || !token.platform) {
    logger.warn(`Missing contractAddress or platform for wallet distribution score`);
    return 0;
  }

  const cacheKey = `holders_${token.contractAddress}_${token.platform}`;
  const cachedScore = cache.get<number>(cacheKey);
  if (cachedScore !== null) {
    logger.info(`Using cached wallet distribution score for ${token.contractAddress}`);
    return cachedScore;
  }

  try {
    let top10Holdings = 0;
    let totalSupply = token.totalSupply || 1e9;

    if (token.platform === 'ethereum') {
      const response = await axios.get(ETHERSCAN_API, {
        params: {
          module: 'token',
          action: 'tokenholderlist',
          contractaddress: token.contractAddress,
          apikey: process.env.ETHERSCAN_API_KEY || '',
          page: 1,
          offset: 10,
        },
        timeout: 5000,
      });

      if (response.data.status !== '1') {
        logger.warn(`Etherscan API error for ${token.contractAddress}: ${response.data.message}`);
        return 0;
      }

      const holders = response.data.result;
      top10Holdings = holders.reduce((sum: number, h: { balance: string }) => sum + parseFloat(h.balance), 0);
    } else if (token.platform === 'solana') {
      const connection = new Connection(SOLANA_RPC, 'confirmed');
      const mintPubkey = new PublicKey(token.contractAddress);
      const accounts = await connection.getTokenLargestAccounts(mintPubkey);
      top10Holdings = accounts.value
        .slice(0, 10)
        .reduce((sum: number, acc: { amount: string }) => sum + parseFloat(acc.amount), 0);
      const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
      if (
        mintInfo.value &&
        typeof mintInfo.value.data === 'object' &&
        'parsed' in mintInfo.value.data
      ) {
        // @ts-ignore
        totalSupply = mintInfo.value.data.parsed.info.supply || totalSupply;
      }
    }

    const top10Percentage = top10Holdings / totalSupply;
    const score = 100 - top10Percentage * 100;
    const finalScore = Math.min(Math.max(score, 0), 100);
    cache.set(cacheKey, finalScore, 86400);
    return finalScore;
  } catch (error: any) {
    logger.error(`Error calculating wallet distribution score for ${token.contractAddress}: ${error.message}`);
    return 0;
  }
}

export async function calculateTokenMetrics(token: TokenInput): Promise<TokenMetrics> {
  const volumeMarketCapRatio = token.marketCap > 0 ? token.volume24h / token.marketCap : 0;
  const circulatingSupplyPercentage =
    token.circulatingSupply && token.totalSupply && token.totalSupply > 0
      ? (token.circulatingSupply / token.totalSupply) * 100
      : 0;
  const potentialMultiplier =
    token.targetMarketCap && token.marketCap > 0 ? token.targetMarketCap / token.marketCap : 0;

  const walletDistributionScore = await calculateWalletDistributionScore(token);

  return {
    marketCap: token.marketCap,
    fullyDilutedValuation: token.price * (token.totalSupply || 0),
    volumeMarketCapRatio,
    circulatingSupplyPercentage,
    isVolumeHealthy: volumeMarketCapRatio > 0.1,
    isCirculatingSupplyGood: circulatingSupplyPercentage > 50,
    potentialMultiplier,
    walletDistributionScore,
  };
}