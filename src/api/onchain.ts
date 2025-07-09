import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../services/logger';
import { cache } from '../services/cache';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PrismaClient } from '@prisma/client';
import { calculateWalletDistributionScore } from '../utils/tokenAnalytics';

const prisma = new PrismaClient();
const QUICKNODE_URL = process.env.QUICKNODE_URL || 'https://little-capable-sky.solana-mainnet.quiknode.pro/c840fbf437b0420a5e29d0951f6b90be632da182/';
const ETHERSCAN_API = 'https://api.etherscan.io/api';
const BIRDEYE_API = 'https://public-api.birdeye.so';
const COINGECKO_API = 'https://api.coingecko.com/api/v3';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';

interface OnChainData {
  walletDistributionScore: number | null;
  poolLiquidity: number | null;
  txActivityScore: number | null;
  transferVolume24h: number | null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchBirdeyeData(contractAddress: string): Promise<any> {
  const cacheKey = `birdeye_${contractAddress}_solana`;
  const cachedData = cache.get<any>(cacheKey);
  if (cachedData) {
    logger.info(`Using cached Birdeye data for ${contractAddress}`);
    return cachedData;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await axios.get(`${BIRDEYE_API}/defi/price`, {
        params: { address: contractAddress, network: 'solana', include_liquidity: true },
        headers: { 'X-API-KEY': BIRDEYE_API_KEY },
        timeout: 5000,
      });
      const data = response.data.data;
      cache.set(cacheKey, data, 3600);
      return data;
    } catch (error: any) {
      logger.error(`Birdeye fetch attempt ${attempt} failed for ${contractAddress}: ${error.message}`);
      if (error.response?.status === 429) {
        const delay = Math.pow(2, attempt) * 4000;
        await sleep(delay);
      }
      if (attempt === 5) {
        logger.error(`All Birdeye fetch attempts failed for ${contractAddress}`);
        return {};
      }
    }
  }
  return {};
}

async function fetchCoinGeckoVolume(coingeckoId: string) {
  const cacheKey = `coingecko_volume_${coingeckoId}`;
  const cachedData = cache.get<any>(cacheKey);
  if (cachedData) {
    logger.info(`Using cached CoinGecko volume for ${coingeckoId}`);
    return cachedData;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await axios.get(`${COINGECKO_API}/coins/markets`, {
        params: { vs_currency: 'usd', ids: coingeckoId.toLowerCase() },
        timeout: 5000,
      });
      const data = response.data[0];
      cache.set(cacheKey, data, 3600);
      return data;
    } catch (error: any) {
      logger.error(`CoinGecko volume fetch attempt ${attempt} failed for ${coingeckoId}: ${error.message}`);
      if (error.response?.status === 429) {
        const delay = Math.pow(2, attempt) * 4000;
        await sleep(delay);
      }
      if (attempt === 5) {
        logger.error(`All CoinGecko volume fetch attempts failed for ${coingeckoId}`);
        return null;
      }
    }
  }
  return null;
}

export async function fetchHistoricalVolume(symbol: string) {
  const historical = await prisma.tokenHistory.findMany({
    where: { token: { symbol }, timestamp: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    select: { volume24h: true },
  });
  const avgVolume = historical.reduce((sum, h) => sum + (h.volume24h || 0), 0) / (historical.length || 1);
  return avgVolume || null;
}

async function fetchHistoricalVolumeFallback(symbol: string): Promise<number | null> {
  const historical = await prisma.tokenHistory.findFirst({
    where: { token: { symbol }, timestamp: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    select: { volume24h: true },
    orderBy: { timestamp: 'desc' },
  });
  return historical?.volume24h || null;
}

async function fetchEtherscanTransfers(contractAddress: string) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const endBlock = await getLatestBlock();
      const startBlock = endBlock - 5760; // ~24 hours (15s/block)
      const response = await axios.get(ETHERSCAN_API, {
        params: {
          module: 'account',
          action: 'tokentx',
          contractaddress: contractAddress,
          startblock: startBlock,
          endblock: endBlock,
          sort: 'desc',
          apikey: ETHERSCAN_API_KEY,
        },
        timeout: 5000,
      });
      if (response.data.status === '1') return response.data.result;
      logger.warn(`Etherscan transfers fetch failed for ${contractAddress}: ${response.data.message}`);
      await sleep(2000 + Math.random() * 2000);
    } catch (error: any) {
      logger.error(`Etherscan transfers attempt ${attempt} failed for ${contractAddress}: ${error.message}`);
      if (attempt < 5) await sleep(2000 * attempt);
    }
  }
  return [];
}

async function getLatestBlock() {
  try {
    const response = await axios.get(ETHERSCAN_API, {
      params: { module: 'proxy', action: 'eth_blockNumber', apikey: ETHERSCAN_API_KEY },
      timeout: 5000,
    });
    return parseInt(response.data.result, 16);
  } catch (error: any) {
    logger.error(`Etherscan block fetch failed: ${error.message}`);
    return 0;
  }
}

async function fetchCoinGeckoPrice(coingeckoId: string): Promise<number | null> {
  const cacheKey = `coingecko_price_${coingeckoId}`;
  const cachedPrice = cache.get<number | null>(cacheKey);
  if (cachedPrice !== undefined) {
    logger.info(`Using cached CoinGecko price for ${coingeckoId}`);
    return cachedPrice;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await axios.get(`${COINGECKO_API}/simple/price`, {
        params: { ids: coingeckoId.toLowerCase(), vs_currencies: 'usd' },
        timeout: 5000,
      });
      const price = response.data[coingeckoId.toLowerCase()]?.usd || null;
      cache.set(cacheKey, price, 3600);
      return price;
    } catch (error: any) {
      logger.error(`CoinGecko price fetch attempt ${attempt} failed for ${coingeckoId}: ${error.message}`);
      if (error.response?.status === 429) {
        const delay = Math.pow(2, attempt) * 4000;
        await sleep(delay);
      }
      if (attempt === 5) {
        logger.error(`All CoinGecko price fetch attempts failed for ${coingeckoId}`);
        return null;
      }
    }
  }
  return null;
}

async function calculateTransferVolume(transfers: any[], coingeckoId: string): Promise<number> {
  const price = await fetchCoinGeckoPrice(coingeckoId) || 1;
  return transfers.reduce((sum, tx) => sum + (parseInt(tx.value) / 1e18) * price, 0);
}

function calculateTxActivityScore(currentVolume: number, historicalVolume: number | null): number {
  if (!currentVolume || !historicalVolume) return 0;
  const ratio = currentVolume / historicalVolume;
  return Math.min(Math.max(ratio * 50, 0), 100);
}

export async function fetchOnChainData(
  coingeckoId: string,
  symbol: string,
  contractAddress: string,
  platform: string
): Promise<OnChainData | null> {
  const cacheKey = `onchain_${contractAddress}_${platform}`;
  const cachedData = cache.get<OnChainData>(cacheKey);
  if (cachedData && (cachedData.transferVolume24h !== null || cachedData.walletDistributionScore !== null)) {
    logger.info(`Using cached on-chain data for ${contractAddress}`);
    return cachedData;
  }

  if (platform !== 'solana' && platform !== 'ethereum') {
    logger.warn(`Skipping on-chain data fetch for unsupported platform: ${platform}`);
    return null;
  }

  try {
    let walletDistributionScore: number | null = null;
    let poolLiquidity: number | null = null;
    let txActivityScore: number | null = null;
    let transferVolume24h: number | null = null;

    // Calculate walletDistributionScore for both platforms
    walletDistributionScore = await calculateWalletDistributionScore({
      contractAddress,
      platform,
      totalSupply: undefined, // Let calculateWalletDistributionScore handle the fallback
      symbol,
      coingeckoId,
    });

    if (platform === 'solana') {
      const birdeyeData = await fetchBirdeyeData(contractAddress);
      transferVolume24h = birdeyeData?.v24hUSD || null;
      if (transferVolume24h) {
        const historicalVolume = await fetchHistoricalVolume(symbol);
        txActivityScore = calculateTxActivityScore(transferVolume24h, historicalVolume);
        poolLiquidity = birdeyeData?.liquidity || null;
      }
      if (!transferVolume24h) {
        transferVolume24h = await fetchHistoricalVolumeFallback(symbol);
        logger.warn(`Using historical fallback for transferVolume24h: ${symbol}`);
      }
      if (!poolLiquidity) {
        poolLiquidity = await fetchHistoricalVolumeFallback(symbol);
        logger.warn(`Using historical fallback for poolLiquidity: ${symbol}`);
      }
      if (!txActivityScore && transferVolume24h) {
        const historicalVolume = await fetchHistoricalVolume(symbol);
        txActivityScore = calculateTxActivityScore(transferVolume24h, historicalVolume);
      }
    } else if (platform === 'ethereum') {
      const transfers = await fetchEtherscanTransfers(contractAddress);
      transferVolume24h = await calculateTransferVolume(transfers, coingeckoId);
      if (transferVolume24h) {
        const historicalVolume = await fetchHistoricalVolume(symbol);
        txActivityScore = calculateTxActivityScore(transferVolume24h, historicalVolume);
        const coingeckoData = await fetchCoinGeckoVolume(coingeckoId);
        poolLiquidity = coingeckoData?.total_volume || null;
        if (!poolLiquidity) {
          poolLiquidity = await fetchHistoricalVolumeFallback(symbol);
          logger.warn(`Using historical fallback for poolLiquidity: ${symbol}`);
        }
      } else {
        transferVolume24h = await fetchHistoricalVolumeFallback(symbol);
        logger.warn(`Using historical fallback for transferVolume24h: ${symbol}`);
      }
      if (!txActivityScore && transferVolume24h) {
        const historicalVolume = await fetchHistoricalVolume(symbol);
        txActivityScore = calculateTxActivityScore(transferVolume24h, historicalVolume);
      }
    }

    const result: OnChainData = {
      walletDistributionScore,
      poolLiquidity,
      txActivityScore,
      transferVolume24h,
    };

    cache.set(cacheKey, result, 3600);
    logger.info(`Fetched on-chain data for ${symbol} (${contractAddress}, ${platform}): walletDistributionScore=${walletDistributionScore}`);
    return result;
  } catch (error: any) {
    logger.error(`Error fetching on-chain data for ${symbol} (${contractAddress}, ${platform}): ${error.message}`);
    return null;
  }
}