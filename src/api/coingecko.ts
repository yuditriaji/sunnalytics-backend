// src/api/coingecko.ts
import axios from 'axios';
import { logger } from '../services/logger';
import { cache } from '../services/cache';

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
  platforms?: { [key: string]: string };
  price_change_percentage_24h?: number;
}

export interface ExchangeToken {
  coinId: string;
  symbol: string;
  exchange: string;
}

export async function fetchMarketData(maxRetries = 3): Promise<CoinGeckoToken[]> {
  const cacheKey = 'coingecko_market_data';
  const cachedData = cache.get<CoinGeckoToken[]>(cacheKey);
  if (cachedData) {
    logger.info('Using cached CoinGecko market data');
    return cachedData;
  }

  let allTokens: CoinGeckoToken[] = [];
  let page = 1;
  const perPage = 250;

  while (true) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const delay = Math.random() * 2000 + 1000 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));

        logger.info(`Attempting CoinGecko API call for page ${page}, attempt ${attempt}`);
        const res = await axios.get(`${BASE}/coins/markets`, {
          params: {
            vs_currency: 'usd',
            order: 'market_cap_desc',
            per_page: perPage,
            page,
            sparkline: false,
            price_change_percentage: '24h',
          },
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        });
        const tokens = res.data.map((token: any) => ({
          ...token,
          current_price: token.current_price,
          market_cap: token.market_cap,
          total_volume: token.total_volume,
          circulating_supply: token.circulating_supply,
          total_supply: token.total_supply,
          price_change_percentage_24h: token.price_change_percentage_24h,
        })) as CoinGeckoToken[];
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
          await new Promise((resolve) => setTimeout(resolve, 10000 * attempt));
          continue;
        }
        if (attempt === maxRetries) throw new Error(`Failed to fetch CoinGecko data for page ${page} after retries`);
      }
    }
    if (allTokens.length === 0) throw new Error('No data fetched from CoinGecko');
    break;
  }

  const enrichedTokens = await Promise.all(
    allTokens.map(async (token) => {
      const platformCacheKey = `platform_${token.id}`;
      const cachedPlatform = cache.get<{ platforms: { [key: string]: string } }>(platformCacheKey);
      if (cachedPlatform) {
        return { ...token, platforms: cachedPlatform.platforms };
      }

      try {
        const delay = Math.random() * 1000 + 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));

        const details = await axios.get(`${BASE}/coins/${token.id}`, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000,
        });
        const platforms = details.data.platforms || {};
        cache.set(platformCacheKey, { platforms }, 86400);
        return { ...token, platforms };
      } catch (error: any) {
        logger.warn(`Failed to fetch platform data for ${token.id}: ${error.message}`);
        return token;
      }
    })
  );

  cache.set(cacheKey, enrichedTokens, 3600); // Cache for 1 hour
  logger.info(`Total tokens fetched: ${enrichedTokens.length}`);
  return enrichedTokens;
}

export async function fetchExchangeTokens(exchanges: string[] = ['binance', 'bybit_spot'], maxRetries = 3): Promise<ExchangeToken[]> {
  const cacheKey = 'exchange_tokens';
  const cachedData = cache.get<ExchangeToken[]>(cacheKey);
  if (cachedData) {
    logger.info('Using cached exchange tokens');
    return cachedData;
  }

  const exchangeTokens: ExchangeToken[] = [];
  for (const exchange of exchanges) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const delay = Math.random() * 2000 + 1000 * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));

          logger.info(`Fetching ${exchange} tickers, page ${page}, attempt ${attempt}`);
          const response = await axios.get(`${BASE}/exchanges/${exchange}/tickers`, {
            params: {
              per_page: 250,
              page,
            },
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          });

          const tickers = response.data.tickers || [];
          if (tickers.length === 0 || tickers.length < 250) {
            hasMore = false;
          }

          for (const ticker of tickers) {
            if (!ticker.coin_id) {
              logger.warn(`Skipping ticker with missing coin_id for ${exchange}, base: ${ticker.base}`);
              continue;
            }
            exchangeTokens.push({
              coinId: ticker.coin_id,
              symbol: ticker.base.toUpperCase(),
              exchange,
            });
          }

          logger.info(`Fetched ${tickers.length} tickers for ${exchange}, page ${page}`);
          page++;
          break;
        } catch (error: any) {
          logger.error(`CoinGecko API error for ${exchange} tickers, page ${page}, attempt ${attempt}: ${error.message}`);
          if (error.response?.status === 429) {
            logger.warn(`Rate limit hit for ${exchange}, page ${page}, backing off for ${10 * attempt} seconds`);
            await new Promise((resolve) => setTimeout(resolve, 10000 * attempt));
            continue;
          }
          if (attempt === maxRetries) {
            logger.error(`Failed to fetch ${exchange} tickers for page ${page} after retries`);
            hasMore = false;
            break;
          }
        }
      }
    }
  }

  // Aggregate exchanges for each token
  const tokenMap = new Map<string, ExchangeToken>();
  exchangeTokens.forEach((token) => {
    const existing = tokenMap.get(token.coinId);
    if (existing) {
      tokenMap.set(token.coinId, {
        ...existing,
        exchange: existing.exchange.includes(token.exchange)
          ? existing.exchange
          : `${existing.exchange},${token.exchange}`,
      });
    } else {
      tokenMap.set(token.coinId, token);
    }
  });

  const uniqueTokens = Array.from(tokenMap.values());
  cache.set(cacheKey, uniqueTokens, 86400); // Cache for 24 hours
  logger.info(`Fetched ${uniqueTokens.length} unique tokens from exchanges: ${exchanges.join(', ')}`);
  return uniqueTokens;
}
