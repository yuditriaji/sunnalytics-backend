// src/api/onchain.ts
import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../services/logger';
import { cache } from '../services/cache';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const QUICKNODE_URL = process.env.QUICKNODE_URL || 'https://little-capable-sky.solana-mainnet.quiknode.pro/c840fbf437b0420a5e29d0951f6b90be632da182/';
const ETHERSCAN_API = 'https://api.etherscan.io/api';
const BIRDEYE_API = 'https://public-api.birdeye.so';
const BITQUERY_API = 'https://graphql.bitquery.io';
const UNISWAP_SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';
const BITQUERY_TOKEN = process.env.BITQUERY_TOKEN || '';

interface OnChainData {
  walletDistributionScore: number | null;
  poolLiquidity: number | null;
  txActivityScore: number | null;
  transferVolume24h: number | null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchHistoricalVolumeFallback(symbol: string): Promise<number | null> {
  const historical = await prisma.tokenHistory.findFirst({
    where: { token: { symbol }, timestamp: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    select: { volume24h: true },
    orderBy: { timestamp: 'desc' },
  });
  return historical?.volume24h || null;
}

export async function fetchOnChainData(
  coingeckoId: string,
  symbol: string,
  contractAddress: string,
  platform: string
): Promise<OnChainData | null> {
  const cacheKey = `onchain_${contractAddress}_${platform}`;
  const cachedData = cache.get<OnChainData>(cacheKey);
  if (cachedData && (cachedData.walletDistributionScore !== null || cachedData.transferVolume24h !== null)) {
    logger.info(`Using cached on-chain data for ${contractAddress}`);
    return cachedData;
  }

  try {
    let walletDistributionScore: number | null = null;
    let poolLiquidity: number | null = null;
    let txActivityScore: number | null = null;
    let transferVolume24h: number | null = null;

    // Wallet Distribution Score
    if (platform === 'solana') {
      const connection = new Connection(QUICKNODE_URL, 'confirmed');
      const mintPubkey = new PublicKey(contractAddress);
      const accounts = await connection.getTokenLargestAccounts(mintPubkey);
      const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
      let totalSupply = 1e9;
      if (mintInfo.value && typeof mintInfo.value.data === 'object' && 'parsed' in mintInfo.value.data) {
        totalSupply = (mintInfo.value.data as any).parsed.info.supply || totalSupply;
      }
      const top20Holdings = accounts.value
        .slice(0, 20)
        .reduce((sum: number, acc: { amount: string }) => sum + parseFloat(acc.amount), 0);
      const top20Percentage = top20Holdings / totalSupply;
      walletDistributionScore = Math.min(Math.max(100 - top20Percentage * 100, 0), 100);
    } else if (platform === 'ethereum') {
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const response = await axios.get(ETHERSCAN_API, {
            params: {
              module: 'token',
              action: 'tokenholderlist',
              contractaddress: contractAddress,
              apikey: ETHERSCAN_API_KEY,
              page: 1,
              offset: 20,
            },
            timeout: 5000,
          });
          if (response.data.status === '1') {
            const holders = response.data.result;
            const totalSupply = await fetchTokenSupply(contractAddress);
            const top20Holdings = holders.reduce((sum: number, h: { balance: string }) => sum + parseFloat(h.balance), 0);
            const top20Percentage = top20Holdings / totalSupply;
            walletDistributionScore = Math.min(Math.max(100 - top20Percentage * 100, 0), 100);
            break;
          }
          logger.warn(`Etherscan holders fetch failed for ${contractAddress}: ${response.data.message}`);
          await sleep(4000 + Math.random() * 2000);
        } catch (error: any) {
          logger.error(`Etherscan holders attempt ${attempt} failed for ${contractAddress}: ${error.message}`);
          if (attempt < 5) await sleep(4000 * attempt);
        }
      }
    } else if (['polygon', 'arbitrum', 'optimism', 'avalanche', 'bnb'].includes(platform)) {
      logger.warn(`Wallet distribution not yet supported for ${platform}`);
    }

    // Transfer Volume and Tx Activity Score
    if (platform === 'solana' || ['polygon', 'arbitrum', 'optimism', 'bnb'].includes(platform)) {
      const birdeyeData = await fetchBirdeyeData(contractAddress, platform);
      transferVolume24h = birdeyeData?.v24hUSD || null;
      if (transferVolume24h) {
        const historicalVolume = await fetchHistoricalVolume(symbol);
        txActivityScore = calculateTxActivityScore(transferVolume24h, historicalVolume);
        poolLiquidity = birdeyeData?.liquidity || null;
      }
      if (!transferVolume24h) {
        const coingeckoData = await fetchCoinGeckoVolume(coingeckoId);
        transferVolume24h = coingeckoData?.total_volume || null;
        if (!transferVolume24h) {
          transferVolume24h = await fetchHistoricalVolumeFallback(symbol);
        }
        logger.warn(`Using fallback for transferVolume24h: ${symbol}`);
      }
      if (!poolLiquidity) {
        poolLiquidity = await fetchHistoricalVolumeFallback(symbol);
        logger.warn(`Using historical fallback for poolLiquidity: ${symbol}`);
      }
    } else if (platform === 'ethereum') {
      const transfers = await fetchEtherscanTransfers(contractAddress);
      transferVolume24h = await calculateTransferVolume(transfers, coingeckoId);
      if (transferVolume24h) {
        const historicalVolume = await fetchHistoricalVolume(symbol);
        txActivityScore = calculateTxActivityScore(transferVolume24h, historicalVolume);
        const uniswapData = await fetchUniswapLiquidity(contractAddress);
        poolLiquidity = uniswapData?.liquidity || null;
        if (!poolLiquidity) {
          const coingeckoData = await fetchCoinGeckoVolume(coingeckoId);
          poolLiquidity = coingeckoData?.total_volume || null;
          if (!poolLiquidity) {
            poolLiquidity = await fetchHistoricalVolumeFallback(symbol);
            logger.warn(`Using historical fallback for poolLiquidity: ${symbol}`);
          } else {
            logger.warn(`Using CoinGecko fallback for poolLiquidity: ${symbol}`);
          }
        }
      } else {
        transferVolume24h = await fetchHistoricalVolumeFallback(symbol);
        logger.warn(`Using historical fallback for transferVolume24h: ${symbol}`);
      }
    }

    const result: OnChainData = {
      walletDistributionScore,
      poolLiquidity,
      txActivityScore,
      transferVolume24h,
    };

    cache.set(cacheKey, result, platform === 'solana' || platform === 'ethereum' ? 3600 : 172800);
    return result;
  } catch (error: any) {
    logger.error(`Error fetching on-chain data for ${symbol} (${contractAddress}, ${platform}): ${error.message}`);
    return null;
  }
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

async function fetchTokenSupply(contractAddress: string) {
  try {
    const response = await axios.get(ETHERSCAN_API, {
      params: {
        module: 'stats',
        action: 'tokensupply',
        contractaddress: contractAddress,
        apikey: ETHERSCAN_API_KEY,
      },
      timeout: 5000,
    });
    return response.data.status === '1' ? parseFloat(response.data.result) : 1e18;
  } catch (error: any) {
    logger.error(`Etherscan token supply fetch failed for ${contractAddress}: ${error.message}`);
    return 1e18;
  }
}

async function fetchUniswapLiquidity(contractAddress: string) {
  try {
    const query = `
      {
        pools(where: { 
          or: [
            { token0: "${contractAddress.toLowerCase()}" },
            { token1: "${contractAddress.toLowerCase()}" },
            { token0: "${contractAddress.toLowerCase()}", token1_in: ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"] },
            { token1: "${contractAddress.toLowerCase()}", token0_in: ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"] }
          ]
        }, first: 1) {
          liquidity
          volumeUSD
        }
      }`;
    const response = await axios.post(UNISWAP_SUBGRAPH_URL, { query }, { timeout: 5000 });
    const pools = response.data.data?.pools;
    if (!pools || pools.length === 0) {
      logger.warn(`No Uniswap pools found for ${contractAddress}`);
      return null;
    }
    return pools[0];
  } catch (error: any) {
    logger.error(`Uniswap subgraph fetch failed for ${contractAddress}: ${error.message}`);
    return null;
  }
}

// New helper function to validate Birdeye addresses (stub, can be enhanced with actual validation)
function isValidBirdeyeAddress(contractAddress: string): boolean {
  // Placeholder: Add actual validation logic (e.g., check address format or known tokens)
  return contractAddress.length === 42 || contractAddress.length === 44; // Basic Solana/EVM address length check
}

async function fetchBirdeyeData(contractAddress: string, platform: string) {
  const platformMap: { [key: string]: string } = {
    solana: 'solana',
    ethereum: 'eth',
    polygon: 'polygon',
    arbitrum: 'arbitrum',
    optimism: 'optimism',
    avalanche: 'avax_cchain',
    bnb: 'bsc',
  };
  if (!(platform in platformMap)) {
    logger.warn(`Unsupported platform for Birdeye: ${platform}`);
    return {};
  }
  // Skip Avalanche unless address is verified (temporary workaround for 400 errors)
  if (platform === 'avalanche' && !isValidBirdeyeAddress(contractAddress)) {
    logger.warn(`Skipping Birdeye for invalid Avalanche address: ${contractAddress}`);
    return {};
  }
  const cacheKey = `birdeye_${contractAddress}_${platform}`;
  const cachedData = cache.get<any>(cacheKey);
  if (cachedData) {
    logger.info(`Using cached Birdeye data for ${contractAddress} (${platform})`);
    return cachedData;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await axios.get(`${BIRDEYE_API}/defi/price`, {
        params: { address: contractAddress, network: platformMap[platform], include_liquidity: true },
        headers: { 'X-API-KEY': BIRDEYE_API_KEY },
        timeout: 5000,
      });
      const data = response.data.data;
      cache.set(cacheKey, data, 3600); // Cache for 1 hour
      return data;
    } catch (error: any) {
      logger.error(`Birdeye fetch attempt ${attempt} failed for ${contractAddress} (${platform}): ${error.message}`);
      if (error.response?.status === 429) {
        const delay = Math.pow(2, attempt) * 4000; // Exponential backoff: 4s, 8s, 16s
        await sleep(delay);
      } else if (error.response?.status === 400 && platform === 'avalanche') {
        logger.warn(`Invalid Avalanche address for Birdeye: ${contractAddress}`);
        return {};
      }
      if (attempt === 5) {
        logger.error(`All Birdeye fetch attempts failed for ${contractAddress} (${platform})`);
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
      const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
        params: { vs_currency: 'usd', ids: coingeckoId.toLowerCase() },
        timeout: 5000,
      });
      const data = response.data[0];
      cache.set(cacheKey, data, 3600); // Cache for 1 hour
      return data;
    } catch (error: any) {
      logger.error(`CoinGecko volume fetch attempt ${attempt} failed for ${coingeckoId}: ${error.message}`);
      if (error.response?.status === 429) {
        const delay = Math.pow(2, attempt) * 4000; // Exponential backoff
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

async function fetchHistoricalVolume(symbol: string) {
  const historical = await prisma.tokenHistory.findMany({
    where: { token: { symbol }, timestamp: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    select: { volume24h: true },
  });
  const avgVolume = historical.reduce((sum, h) => sum + (h.volume24h || 0), 0) / historical.length;
  return avgVolume || null;
}

async function calculateTransferVolume(transfers: any[], coingeckoId: string): Promise<number> {
  const price = await fetchCoinGeckoPrice(coingeckoId) || 1; // Fallback to 1 if price is null
  return transfers.reduce((sum, tx) => sum + (parseInt(tx.value) / 1e18) * price, 0);
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
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
        params: { ids: coingeckoId.toLowerCase(), vs_currencies: 'usd' },
        timeout: 5000,
      });
      const price = response.data[coingeckoId.toLowerCase()]?.usd || null;
      cache.set(cacheKey, price, 3600); // Cache for 1 hour
      return price;
    } catch (error: any) {
      logger.error(`CoinGecko price fetch attempt ${attempt} failed for ${coingeckoId}: ${error.message}`);
      if (error.response?.status === 429) {
        const delay = Math.pow(2, attempt) * 4000; // Exponential backoff
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

function calculateTxActivityScore(currentVolume: number, historicalVolume: number | null): number {
  if (!currentVolume || !historicalVolume) return 0;
  const ratio = currentVolume / historicalVolume;
  return Math.min(Math.max(ratio * 50, 0), 100); // Normalize to 0-100
}