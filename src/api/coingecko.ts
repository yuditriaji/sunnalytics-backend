import axios from 'axios';
import { logger } from '../services/logger';

const BASE = 'https://api.coingecko.com/api/v3';

export interface CoinGeckoToken {
  id: string;
  name: string;
  symbol: string;
  current_price: number;
  market_cap: number;
  total_supply: number;
  circulating_supply: number;
  total_volume: number;
}

export async function fetchMarketData(maxRetries = 3): Promise<CoinGeckoToken[]> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Random delay to avoid rate limits (1-3 seconds)
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));
      
      const res = await axios.get(`${BASE}/coins/markets`, {
        params: {
          vs_currency: 'usd',
          order: 'market_cap_desc',
          per_page: 100,
          page: 1,
          sparkline: false
        },
        timeout: 10000
      });
      logger.info(`CoinGecko API call successful, attempt ${attempt}`);
      return res.data;
    } catch (error: any) {
      logger.error(`CoinGecko API error, attempt ${attempt}: ${error.message}`);
      if (attempt === maxRetries) throw new Error('Failed to fetch CoinGecko data after retries');
    }
  }
  throw new Error('Unexpected error in fetchMarketData');
}