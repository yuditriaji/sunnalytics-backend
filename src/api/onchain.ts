import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../services/logger';
import { cache } from '../services/cache';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

const QUICKNODE_URL = process.env.QUICKNODE_URL || 'https://little-capable-sky.solana-mainnet.quiknode.pro/c840fbf437b0420a5e29d0951f6b90be632da182/';
const ETHERSCAN_API = 'https://api.etherscan.io/api';
const BIRDEYE_API = 'https://public-api.birdeye.so';
const BITQUERY_API = 'https://graphql.bitquery.io';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';
const BITQUERY_TOKEN = process.env.BITQUERY_TOKEN || '';

interface OnChainData {
  walletDistributionScore: number | null;
  poolLiquidity: number | null;
  txActivityScore: number | null;
  transferVolume24h: number | null;
}

export async function fetchOnChainData(
  coingeckoId: string,
  symbol: string,
  contractAddress: string,
  platform: string
): Promise<OnChainData | null> {
  const cacheKey = `onchain_${contractAddress}_${platform}`;
  const cachedData = cache.get<OnChainData>(cacheKey);
  if (cachedData) {
    logger.info(`Using cached on-chain data for ${contractAddress}`);
    return cachedData;
  }

  try {
    let walletDistributionScore: number | null = null;
    let poolLiquidity: number | null = null;
    let txActivityScore: number | null = null;
    let transferVolume24h: number | null = null;

    // Wallet Distribution Score (Top-20 Holders)
    if (platform === 'solana') {
      const connection = new Connection(QUICKNODE_URL, 'confirmed');
      const mintPubkey = new PublicKey(contractAddress);
      const accounts = await connection.getTokenLargestAccounts(mintPubkey);
      const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
      let totalSupply = 1e9;
      if (
        mintInfo.value &&
        typeof mintInfo.value.data === 'object' &&
        'parsed' in mintInfo.value.data
      ) {
        totalSupply = (mintInfo.value.data as any).parsed.info.supply || totalSupply;
      }
      const top20Holdings = accounts.value
        .slice(0, 20)
        .reduce((sum: number, acc: { amount: string }) => sum + parseFloat(acc.amount), 0);
      const top20Percentage = top20Holdings / totalSupply;
      walletDistributionScore = Math.min(Math.max(100 - top20Percentage * 100, 0), 100);
    } else if (platform === 'ethereum') {
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
        const totalSupply = 1e18; // Default for Ethereum tokens
        const top20Holdings = holders.reduce((sum: number, h: { balance: string }) => sum + parseFloat(h.balance), 0);
        const top20Percentage = top20Holdings / totalSupply;
        walletDistributionScore = Math.min(Math.max(100 - top20Percentage * 100, 0), 100);
      }
    }

    // Transfer Volume (Bitquery, Solana only)
    if (platform === 'solana') {
      try {
        const response = await axios.post(
          BITQUERY_API,
          {
            query: `
              query($symbols: [String!], $since: ISO8601DateTime) {
                solana(network: solana) {
                  transfers(
                    currency: { symbol: $symbols }
                    date: { after: $since }
                    options: { limit: 200 }
                  ) {
                    currency { symbol address }
                    amount
                    price: amount(in: USD)
                  }
                }
              }
            `,
            variables: {
              symbols: [symbol.toUpperCase()],
              since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            },
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'X-API-KEY': BITQUERY_TOKEN,
            },
            timeout: 5000,
          }
        );
        const transfers = response.data.data.solana.transfers || [];
        transferVolume24h = transfers.reduce((sum: number, t: { price: number }) => sum + t.price, 0);
      } catch (error: any) {
        logger.warn(`Bitquery transfer volume fetch failed for ${symbol}: ${error.message}`);
      }
    }

    // Tx Activity Score and Pool Liquidity (Birdeye, Solana only)
    if (platform === 'solana') {
      try {
        const tokenListResponse = await axios.get(`${BIRDEYE_API}/defi/tokenlist`, {
          headers: { 'X-API-KEY': BIRDEYE_API_KEY },
          timeout: 5000,
        });
        const tokenData = tokenListResponse.data.data.tokens.find(
          (t: any) => t.address.toLowerCase() === contractAddress.toLowerCase()
        );
        if (tokenData) {
          const v24hUSD = tokenData.v24hUSD || 0;
          const avgV24hUSD7d = tokenData.v24hUSD7d || v24hUSD || 1;
          txActivityScore = Math.min((v24hUSD / avgV24hUSD7d) * 100, 100);

          // Check if transferVolume24h is above median for poolLiquidity
          const medianVolume = tokenListResponse.data.data.tokens
            .map((t: any) => t.v24hUSD || 0)
            .sort((a: number, b: number) => a - b)[
              Math.floor(tokenListResponse.data.data.tokens.length / 2)
            ];
          if (transferVolume24h && transferVolume24h > medianVolume) {
            const priceResponse = await axios.get(`${BIRDEYE_API}/defi/price`, {
              params: { address: contractAddress, include_liquidity: true },
              headers: { 'X-API-KEY': BIRDEYE_API_KEY },
              timeout: 5000,
            });
            poolLiquidity = priceResponse.data.data.liquidity || null;
          }
        }
      } catch (error: any) {
        logger.warn(`Birdeye data fetch failed for ${contractAddress}: ${error.message}`);
      }
    }

    const result: OnChainData = {
      walletDistributionScore,
      poolLiquidity,
      txActivityScore,
      transferVolume24h,
    };

    cache.set(cacheKey, result, 3600); // Cache for 1 hour
    return result;
  } catch (error: any) {
    logger.error(`Error fetching on-chain data for ${contractAddress}: ${error.message}`);
    return null;
  }
}