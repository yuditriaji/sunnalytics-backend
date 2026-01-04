import axios from 'axios';
import { logger } from '../services/logger';

// Exchange API endpoints
const EXCHANGES = {
    binance: 'https://api.binance.com/api/v3/exchangeInfo',
    bybit: 'https://api.bybit.com/v5/market/instruments-info?category=spot',
    htx: 'https://api.huobi.pro/v1/common/symbols',
    mexc: 'https://api.mexc.com/api/v3/exchangeInfo',
    gateio: 'https://api.gateio.ws/api/v4/spot/currency_pairs',
};

export interface ExchangeToken {
    symbol: string;
    name: string;
    exchanges: string[];
}

/**
 * Fetch all tokens from Binance
 */
async function fetchBinanceTokens(): Promise<Map<string, string[]>> {
    const tokenMap = new Map<string, string[]>();
    try {
        const response = await axios.get(EXCHANGES.binance, { timeout: 30000 });
        const symbols = response.data.symbols || [];

        for (const sym of symbols) {
            if (sym.status === 'TRADING') {
                const base = sym.baseAsset.toUpperCase();
                if (!tokenMap.has(base)) {
                    tokenMap.set(base, ['binance']);
                }
            }
        }
        logger.info(`Binance: ${tokenMap.size} unique tokens`);
    } catch (error: any) {
        logger.error(`Binance fetch failed: ${error.message}`);
    }
    return tokenMap;
}

/**
 * Fetch all tokens from Bybit
 */
async function fetchBybitTokens(): Promise<Map<string, string[]>> {
    const tokenMap = new Map<string, string[]>();
    try {
        const response = await axios.get(EXCHANGES.bybit, { timeout: 30000 });
        const symbols = response.data.result?.list || [];

        for (const sym of symbols) {
            if (sym.status === 'Trading') {
                const base = sym.baseCoin.toUpperCase();
                if (!tokenMap.has(base)) {
                    tokenMap.set(base, ['bybit']);
                }
            }
        }
        logger.info(`Bybit: ${tokenMap.size} unique tokens`);
    } catch (error: any) {
        logger.error(`Bybit fetch failed: ${error.message}`);
    }
    return tokenMap;
}

/**
 * Fetch all tokens from HTX (Huobi)
 */
async function fetchHTXTokens(): Promise<Map<string, string[]>> {
    const tokenMap = new Map<string, string[]>();
    try {
        const response = await axios.get(EXCHANGES.htx, { timeout: 30000 });
        const symbols = response.data.data || [];

        for (const sym of symbols) {
            if (sym.state === 'online') {
                const base = sym['base-currency'].toUpperCase();
                if (!tokenMap.has(base)) {
                    tokenMap.set(base, ['htx']);
                }
            }
        }
        logger.info(`HTX: ${tokenMap.size} unique tokens`);
    } catch (error: any) {
        logger.error(`HTX fetch failed: ${error.message}`);
    }
    return tokenMap;
}

/**
 * Fetch all tokens from MEXC
 */
async function fetchMEXCTokens(): Promise<Map<string, string[]>> {
    const tokenMap = new Map<string, string[]>();
    try {
        const response = await axios.get(EXCHANGES.mexc, { timeout: 30000 });
        const symbols = response.data.symbols || [];

        for (const sym of symbols) {
            if (sym.status === 'ENABLED' || sym.isSpotTradingAllowed) {
                const base = sym.baseAsset.toUpperCase();
                if (!tokenMap.has(base)) {
                    tokenMap.set(base, ['mexc']);
                }
            }
        }
        logger.info(`MEXC: ${tokenMap.size} unique tokens`);
    } catch (error: any) {
        logger.error(`MEXC fetch failed: ${error.message}`);
    }
    return tokenMap;
}

/**
 * Fetch all tokens from Gate.io (includes token names!)
 */
async function fetchGateioTokens(): Promise<Map<string, { name: string; exchanges: string[] }>> {
    const tokenMap = new Map<string, { name: string; exchanges: string[] }>();
    try {
        const response = await axios.get(EXCHANGES.gateio, { timeout: 30000 });
        const pairs = response.data || [];

        for (const pair of pairs) {
            if (pair.trade_status === 'tradable') {
                const base = pair.base.toUpperCase();
                if (!tokenMap.has(base)) {
                    tokenMap.set(base, {
                        name: pair.base_name || base,
                        exchanges: ['gateio']
                    });
                }
            }
        }
        logger.info(`Gate.io: ${tokenMap.size} unique tokens`);
    } catch (error: any) {
        logger.error(`Gate.io fetch failed: ${error.message}`);
    }
    return tokenMap;
}

/**
 * Fetch and merge tokens from all 5 exchanges
 * Returns tokens that exist on at least one exchange
 */
export async function fetchAllExchangeTokens(): Promise<ExchangeToken[]> {
    logger.info('🔄 Fetching tokens from all exchanges...');

    // Fetch from all exchanges in parallel
    const [binance, bybit, htx, mexc, gateio] = await Promise.all([
        fetchBinanceTokens(),
        fetchBybitTokens(),
        fetchHTXTokens(),
        fetchMEXCTokens(),
        fetchGateioTokens(),
    ]);

    // Merge all tokens
    const merged = new Map<string, { name: string; exchanges: string[] }>();

    // Gate.io has names, use as base
    for (const [symbol, data] of gateio) {
        merged.set(symbol, { name: data.name, exchanges: [...data.exchanges] });
    }

    // Add other exchanges
    const addExchange = (map: Map<string, string[]>, exchangeName: string) => {
        for (const [symbol] of map) {
            if (merged.has(symbol)) {
                merged.get(symbol)!.exchanges.push(exchangeName);
            } else {
                merged.set(symbol, { name: symbol, exchanges: [exchangeName] });
            }
        }
    };

    addExchange(binance, 'binance');
    addExchange(bybit, 'bybit');
    addExchange(htx, 'htx');
    addExchange(mexc, 'mexc');

    // Convert to array
    const tokens: ExchangeToken[] = [];
    for (const [symbol, data] of merged) {
        tokens.push({
            symbol: symbol.toLowerCase(),
            name: data.name,
            exchanges: [...new Set(data.exchanges)].sort(),
        });
    }

    // Sort by number of exchanges (more = better coverage)
    tokens.sort((a, b) => b.exchanges.length - a.exchanges.length);

    logger.info(`✅ Total unique tokens across exchanges: ${tokens.length}`);
    logger.info(`   Tokens on 5 exchanges: ${tokens.filter(t => t.exchanges.length >= 5).length}`);
    logger.info(`   Tokens on 3+ exchanges: ${tokens.filter(t => t.exchanges.length >= 3).length}`);

    return tokens;
}

/**
 * Get tokens listed on at least N exchanges
 */
export async function fetchTokensOnMultipleExchanges(minExchanges = 2): Promise<ExchangeToken[]> {
    const allTokens = await fetchAllExchangeTokens();
    return allTokens.filter(t => t.exchanges.length >= minExchanges);
}

export default {
    fetchAllExchangeTokens,
    fetchTokensOnMultipleExchanges,
    fetchBinanceTokens,
    fetchBybitTokens,
    fetchHTXTokens,
    fetchMEXCTokens,
    fetchGateioTokens,
};
