import axios from 'axios';
import { logger } from '../services/logger';

const BASE = 'https://openapi.debank.com/v1';

export interface DeBankToken {
  id: string;
  name: string;
  symbol: string;
  price: number;
}

export async function fetchDeBankTokens(maxRetries = 3): Promise<DeBankToken[]> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Random delay to avoid rate limits (2-4 seconds)
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 2000));
      
      const res = await axios.get(`${BASE}/token/list`, {
        params: { chain_id: 'eth' },
        timeout: 10000
      });
      logger.info(`DeBank API call successful, attempt ${attempt}`);
      return res.data;
    } catch (error: any) {
      logger.error(`DeBank API error, attempt ${attempt}: ${error.message}`);
      if (attempt === maxRetries) throw new Error('Failed to fetch DeBank data after retries');
    }
  }
  throw new Error('Unexpected error in fetchDeBankTokens');
}