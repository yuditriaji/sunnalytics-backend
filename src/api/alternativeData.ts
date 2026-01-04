import axios from 'axios';
import { logger } from '../services/logger';

// CoinPaprika API - Unlimited free tier, no API key needed
const COINPAPRIKA_BASE = 'https://api.coinpaprika.com/v1';

// CoinCap API - 200 req/min, no API key needed
const COINCAP_BASE = 'https://api.coincap.io/v2';

export interface TokenInfo {
    id: string;
    name: string;
    symbol: string;
    rank?: number;
    platforms?: Record<string, string>;
}

export interface MarketData {
    id: string;
    symbol: string;
    name: string;
    price: number;
    marketCap: number;
    volume24h: number;
    priceChange24h: number;
}

/**
 * Fetch token list from CoinPaprika (unlimited, no key)
 */
export async function fetchTokenList(): Promise<TokenInfo[]> {
    try {
        const response = await axios.get(`${COINPAPRIKA_BASE}/coins`, {
            timeout: 30000,
        });

        const tokens = response.data
            .filter((coin: any) => coin.is_active && !coin.is_new)
            .slice(0, 5000) // Limit to top 5000
            .map((coin: any) => ({
                id: coin.id,
                name: coin.name,
                symbol: coin.symbol.toLowerCase(),
                rank: coin.rank,
                platforms: {}, // CoinPaprika doesn't provide platform data in list
            }));

        logger.info(`Fetched ${tokens.length} tokens from CoinPaprika`);
        return tokens;
    } catch (error: any) {
        logger.error(`CoinPaprika token list failed: ${error.message}`);
        throw error;
    }
}

/**
 * Fetch market data from CoinCap (200 req/min, no key)
 */
export async function fetchMarketDataBatch(limit = 2000): Promise<MarketData[]> {
    try {
        const response = await axios.get(`${COINCAP_BASE}/assets`, {
            params: { limit },
            timeout: 30000,
        });

        const assets = response.data.data || [];
        const marketData = assets.map((asset: any) => ({
            id: asset.id,
            symbol: asset.symbol.toLowerCase(),
            name: asset.name,
            price: parseFloat(asset.priceUsd) || 0,
            marketCap: parseFloat(asset.marketCapUsd) || 0,
            volume24h: parseFloat(asset.volumeUsd24Hr) || 0,
            priceChange24h: parseFloat(asset.changePercent24Hr) || 0,
        }));

        logger.info(`Fetched ${marketData.length} market data from CoinCap`);
        return marketData;
    } catch (error: any) {
        logger.error(`CoinCap market data failed: ${error.message}`);
        throw error;
    }
}

/**
 * Fetch single token market data from CoinCap
 */
export async function fetchTokenPrice(symbol: string): Promise<MarketData | null> {
    try {
        const response = await axios.get(`${COINCAP_BASE}/assets`, {
            params: { search: symbol, limit: 1 },
            timeout: 10000,
        });

        const asset = response.data.data?.[0];
        if (!asset) return null;

        return {
            id: asset.id,
            symbol: asset.symbol.toLowerCase(),
            name: asset.name,
            price: parseFloat(asset.priceUsd) || 0,
            marketCap: parseFloat(asset.marketCapUsd) || 0,
            volume24h: parseFloat(asset.volumeUsd24Hr) || 0,
            priceChange24h: parseFloat(asset.changePercent24Hr) || 0,
        };
    } catch (error: any) {
        logger.error(`CoinCap price fetch failed for ${symbol}: ${error.message}`);
        return null;
    }
}

/**
 * Fetch token details from CoinPaprika (includes more metadata)
 */
export async function fetchTokenDetails(tokenId: string): Promise<any | null> {
    try {
        const [coinResponse, marketsResponse] = await Promise.all([
            axios.get(`${COINPAPRIKA_BASE}/coins/${tokenId}`, { timeout: 10000 }),
            axios.get(`${COINPAPRIKA_BASE}/coins/${tokenId}/markets`, { timeout: 10000 }).catch(() => null),
        ]);

        const coin = coinResponse.data;
        const markets = marketsResponse?.data || [];

        // Extract exchange names
        const exchanges = [...new Set(markets.map((m: any) => m.exchange_name))].slice(0, 10);

        return {
            id: coin.id,
            name: coin.name,
            symbol: coin.symbol.toLowerCase(),
            description: coin.description,
            logoUrl: coin.logo,
            website: coin.links?.website?.[0],
            twitter: coin.links?.twitter?.[0],
            contractAddress: coin.contract && coin.platform ? coin.contract : null,
            platform: coin.platform,
            exchanges: exchanges.join(','),
        };
    } catch (error: any) {
        logger.error(`CoinPaprika details failed for ${tokenId}: ${error.message}`);
        return null;
    }
}

export default {
    fetchTokenList,
    fetchMarketDataBatch,
    fetchTokenPrice,
    fetchTokenDetails,
};
