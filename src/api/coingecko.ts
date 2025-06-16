import axios from 'axios';
import { logger } from '../services/logger';

const BASE = 'https://api.coingecko.com/api/v3';

export interface CoinGeckoToken {
  id: string;
  name: string;
  symbol: string;
  current_price: number | null;
  market_cap: number | null;
  total_supply: number | null;
  circulating_supply: number | null;
  total_volume: number | null;
  categories?: string[];
  transferAmount?: number;
  platforms?: { [key: string]: string }; // Optional platforms object (e.g., { solana: "address" })
}

export async function fetchMarketData(maxRetries = 3): Promise<CoinGeckoToken[]> {
  let allTokens: CoinGeckoToken[] = [];
  let page = 1;
  const perPage = 250; // Maximum allowed per page

  while (true) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const delay = Math.random() * 2000 + 1000 * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        logger.info(`Attempting CoinGecko API call for page ${page}, attempt ${attempt}`);
        const res = await axios.get(`${BASE}/coins/markets`, {
          params: {
            vs_currency: 'usd',
            order: 'market_cap_desc',
            per_page: perPage,
            page,
            sparkline: false
          },
          timeout: 10000
        });
        const tokens = res.data as CoinGeckoToken[];
        allTokens = [...allTokens, ...tokens];

        logger.info(`Fetched ${tokens.length} tokens for page ${page}, total so far: ${allTokens.length}`);
        if (tokens.length < perPage) {
          logger.info(`No more data after page ${page}, stopping pagination`);
          break;
        }
        page++;
      } catch (error: any) {
        logger.error(`CoinGecko API error for page ${page}, attempt ${attempt}: ${error.message}`);
        if (error.response?.status === 429) {
          logger.warn(`Rate limit hit for page ${page}, backing off for ${10 * attempt} seconds`);
          await new Promise(resolve => setTimeout(resolve, 10000 * attempt));
          continue;
        }
        if (attempt === maxRetries) throw new Error(`Failed to fetch CoinGecko data for page ${page} after retries`);
      }
    }
    if (allTokens.length === 0) throw new Error('No data fetched from CoinGecko');
    break;
  }

  logger.info(`Total tokens fetched: ${allTokens.length}`);
  return allTokens;
}