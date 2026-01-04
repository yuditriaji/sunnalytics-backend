import axios from 'axios';
import { logger } from '../services/logger';

// CoinPaprika API - Unlimited free tier, no API key needed
const COINPAPRIKA_BASE = 'https://api.coinpaprika.com/v1';

// CoinLore API - Free, no API key needed, reliable
const COINLORE_BASE = 'https://api.coinlore.net/api';

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

export interface ContractInfo {
    symbol: string;
    chain: string;
    contractAddress: string;
    type?: string;
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
 * Fetch market data from CoinLore (free, no key, reliable)
 */
export async function fetchMarketDataBatch(limit = 2000): Promise<MarketData[]> {
    try {
        // CoinLore returns max 100 per request, so we paginate
        const allData: MarketData[] = [];
        const perPage = 100;
        const pages = Math.ceil(limit / perPage);

        for (let page = 0; page < pages && allData.length < limit; page++) {
            const response = await axios.get(`${COINLORE_BASE}/tickers/`, {
                params: { start: page * perPage, limit: perPage },
                timeout: 30000,
            });

            const assets = response.data.data || [];
            const marketData = assets.map((asset: any) => ({
                id: asset.nameid || asset.id,
                symbol: asset.symbol.toLowerCase(),
                name: asset.name,
                price: parseFloat(asset.price_usd) || 0,
                marketCap: parseFloat(asset.market_cap_usd) || 0,
                volume24h: parseFloat(asset.volume24) || 0,
                priceChange24h: parseFloat(asset.percent_change_24h) || 0,
            }));

            allData.push(...marketData);

            // Small delay to be nice to the API
            if (page < pages - 1) await new Promise(r => setTimeout(r, 100));
        }

        logger.info(`Fetched ${allData.length} market data from CoinLore`);
        return allData.slice(0, limit);
    } catch (error: any) {
        logger.error(`CoinLore market data failed: ${error.message}`);
        throw error;
    }
}

/**
 * Fetch single token market data from CoinLore
 */
export async function fetchTokenPrice(symbol: string): Promise<MarketData | null> {
    try {
        // CoinLore doesn't have search, so fetch all and find
        const response = await axios.get(`${COINLORE_BASE}/tickers/`, {
            params: { limit: 100 },
            timeout: 10000,
        });

        const assets = response.data.data || [];
        const asset = assets.find((a: any) => a.symbol.toLowerCase() === symbol.toLowerCase());
        if (!asset) return null;

        return {
            id: asset.nameid || asset.id,
            symbol: asset.symbol.toLowerCase(),
            name: asset.name,
            price: parseFloat(asset.price_usd) || 0,
            marketCap: parseFloat(asset.market_cap_usd) || 0,
            volume24h: parseFloat(asset.volume24) || 0,
            priceChange24h: parseFloat(asset.percent_change_24h) || 0,
        };
    } catch (error: any) {
        logger.error(`CoinLore price fetch failed for ${symbol}: ${error.message}`);
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

// Chain name mapping from CoinPaprika to our schema
const CHAIN_MAPPING: Record<string, string> = {
    'eth-ethereum': 'ethereum',
    'sol-solana': 'solana',
    'bnb-bnb': 'bsc',
    'arb-arbitrum': 'arbitrum',
    'base-base': 'base',
    'matic-polygon': 'polygon',
    'avax-avalanche': 'avalanche',
    'op-optimism': 'optimism',
    'trx-tron': 'tron',
};

/**
 * Fetch contract addresses for a token from CoinPaprika
 */
export async function fetchContractAddresses(coinId: string): Promise<ContractInfo[]> {
    try {
        const response = await axios.get(`${COINPAPRIKA_BASE}/coins/${coinId}`, {
            timeout: 10000,
        });

        const coin = response.data;
        const contracts: ContractInfo[] = [];

        if (coin.contracts && Array.isArray(coin.contracts)) {
            for (const contract of coin.contracts) {
                const chain = CHAIN_MAPPING[contract.platform] || contract.platform;

                // Only include chains we support
                if (['ethereum', 'solana', 'bsc', 'arbitrum', 'base', 'polygon'].includes(chain)) {
                    contracts.push({
                        symbol: coin.symbol.toLowerCase(),
                        chain,
                        contractAddress: contract.contract,
                        type: contract.type,
                    });
                }
            }
        }

        return contracts;
    } catch (error: any) {
        // Don't log error for each token - just return empty
        return [];
    }
}

/**
 * Map of symbol to CoinPaprika coin ID
 */
export async function getSymbolToIdMap(): Promise<Map<string, string>> {
    const coins = await fetchTokenList();
    return new Map(coins.map(c => [c.symbol.toLowerCase(), c.id]));
}

export default {
    fetchTokenList,
    fetchMarketDataBatch,
    fetchTokenPrice,
    fetchTokenDetails,
    fetchContractAddresses,
    getSymbolToIdMap,
};
