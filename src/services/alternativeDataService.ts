import { PrismaClient } from '@prisma/client';
import { logger } from './logger';
import { fetchTokenList, fetchMarketDataBatch, fetchContractAddresses, getSymbolToIdMap } from '../api/alternativeData';
import { fetchAllExchangeTokens, ExchangeToken } from '../api/exchangeTokens';
import { fetchOnChainData } from '../api/onchain';

const prisma = new PrismaClient() as any;

/**
 * Populate token headers using CoinPaprika (no rate limits)
 * Run this when CoinGecko is rate limited
 */
export async function populateTokenHeadersFromCoinPaprika(): Promise<{ success: number, errors: string[] }> {
    const result = { success: 0, errors: [] as string[] };

    try {
        logger.info('📊 Fetching token list from CoinPaprika (unlimited, no key)...');

        const tokens = await fetchTokenList();
        logger.info(`Fetched ${tokens.length} tokens from CoinPaprika`);

        const batchSize = 100;
        for (let i = 0; i < tokens.length; i += batchSize) {
            const batch = tokens.slice(i, i + batchSize);

            try {
                await prisma.$transaction(
                    batch.map((token: any) =>
                        prisma.tokenHeader.upsert({
                            where: { id: token.id },
                            update: {
                                symbol: token.symbol.toLowerCase(),
                                name: token.name,
                                platforms: token.platforms || {},
                                updatedAt: new Date()
                            },
                            create: {
                                id: token.id,
                                symbol: token.symbol.toLowerCase(),
                                name: token.name,
                                platforms: token.platforms || {},
                                exchange: null,
                                createdAt: new Date(),
                                updatedAt: new Date()
                            }
                        })
                    )
                );

                result.success += batch.length;

                // Log progress every 1000 tokens
                if (result.success % 1000 === 0) {
                    logger.info(`Progress: ${result.success}/${tokens.length} tokens processed`);
                }

            } catch (error: any) {
                logger.error(`Token header batch failed: ${error.message}`);
                result.errors.push(`Batch ${i}: ${error.message}`);
            }
        }

        logger.info(`✅ Token headers populated: ${result.success} successful`);

    } catch (error: any) {
        logger.error(`Token population failed: ${error.message}`);
        result.errors.push(error.message);
    } finally {
        await prisma.$disconnect();
    }

    return result;
}

/**
 * Create/Update tokens with prices from CoinCap (no rate limits)
 * This creates Token records if they don't exist
 */
export async function updateTokenPricesFromCoinCap(): Promise<{ success: number, errors: string[] }> {
    const result = { success: 0, errors: [] as string[] };

    try {
        logger.info('💰 Fetching market data from CoinCap (200 req/min, no key)...');

        // Fetch market data
        const marketData = await fetchMarketDataBatch(2000);
        logger.info(`Fetched ${marketData.length} tokens with prices from CoinCap`);

        // Get existing token headers to match symbols
        const tokenHeaders = await prisma.tokenHeader.findMany({
            select: { id: true, symbol: true, name: true }
        });

        const headerBySymbol = new Map(
            tokenHeaders.map((h: any) => [h.symbol.toLowerCase(), h])
        );

        logger.info(`Found ${tokenHeaders.length} token headers to match`);

        // Create/update tokens with market data
        for (const data of marketData) {
            const header = headerBySymbol.get(data.symbol.toLowerCase());
            if (!header) continue; // Skip if no matching header

            try {
                // Check if token already exists (symbol is not unique, so find first)
                const existingToken = await prisma.token.findFirst({
                    where: { symbol: data.symbol.toLowerCase() }
                });

                if (existingToken) {
                    // Update existing token
                    await prisma.token.update({
                        where: { id: existingToken.id },
                        data: {
                            name: data.name,
                            price: data.price,
                            marketCap: data.marketCap,
                            volume24h: data.volume24h,
                            priceChange24h: data.priceChange24h,
                            updatedAt: new Date()
                        }
                    });
                } else {
                    // Create new token
                    await prisma.token.create({
                        data: {
                            symbol: data.symbol.toLowerCase(),
                            name: data.name,
                            category: 'altcoin',
                            price: data.price,
                            marketCap: data.marketCap,
                            volume24h: data.volume24h,
                            priceChange24h: data.priceChange24h,
                            createdAt: new Date(),
                            updatedAt: new Date()
                        }
                    });
                }

                result.success++;

                // Log progress every 500 tokens
                if (result.success % 500 === 0) {
                    logger.info(`Progress: ${result.success} tokens processed`);
                }

            } catch (error: any) {
                result.errors.push(`Token ${data.symbol}: ${error.message}`);
            }
        }

        logger.info(`✅ Tokens created/updated: ${result.success} successful`);

    } catch (error: any) {
        logger.error(`Token creation failed: ${error.message}`);
        result.errors.push(error.message);
    } finally {
        await prisma.$disconnect();
    }

    return result;
}

/**
 * Sync tokens that are listed on major CEX exchanges
 * Only creates tokens that exist on Binance, Bybit, HTX, MEXC, or Gate.io
 */
export async function syncExchangeListedTokens(minExchanges = 1): Promise<{ success: number, errors: string[] }> {
    const result = { success: 0, errors: [] as string[] };

    try {
        logger.info('🏦 Fetching tokens from CEX exchanges...');

        // Get all tokens from exchanges
        const exchangeTokens = await fetchAllExchangeTokens();

        // Filter by minimum exchanges
        const filteredTokens = exchangeTokens.filter(t => t.exchanges.length >= minExchanges);
        logger.info(`Found ${filteredTokens.length} tokens on ${minExchanges}+ exchanges`);

        // Create lookup map by symbol
        const exchangeBySymbol = new Map(
            filteredTokens.map(t => [t.symbol.toLowerCase(), t])
        );

        // Fetch market data
        logger.info('💰 Fetching market data from CoinLore...');
        const marketData = await fetchMarketDataBatch(2000);

        // Filter market data to only include exchange-listed tokens
        const filteredMarket = marketData.filter(d =>
            exchangeBySymbol.has(d.symbol.toLowerCase())
        );

        logger.info(`Matched ${filteredMarket.length} tokens with market data`);

        // Create/update tokens
        for (const data of filteredMarket) {
            const exchangeInfo = exchangeBySymbol.get(data.symbol.toLowerCase());
            if (!exchangeInfo) continue;

            try {
                const existingToken = await prisma.token.findFirst({
                    where: { symbol: data.symbol.toLowerCase() }
                });

                if (existingToken) {
                    await prisma.token.update({
                        where: { id: existingToken.id },
                        data: {
                            name: data.name,
                            price: data.price,
                            marketCap: data.marketCap,
                            volume24h: data.volume24h,
                            priceChange24h: data.priceChange24h,
                            exchange: exchangeInfo.exchanges.join(','),
                            updatedAt: new Date()
                        }
                    });
                } else {
                    await prisma.token.create({
                        data: {
                            symbol: data.symbol.toLowerCase(),
                            name: data.name,
                            category: 'altcoin',
                            price: data.price,
                            marketCap: data.marketCap,
                            volume24h: data.volume24h,
                            priceChange24h: data.priceChange24h,
                            exchange: exchangeInfo.exchanges.join(','),
                            createdAt: new Date(),
                            updatedAt: new Date()
                        }
                    });
                }

                result.success++;

                if (result.success % 100 === 0) {
                    logger.info(`Progress: ${result.success} tokens processed`);
                }

            } catch (error: any) {
                result.errors.push(`Token ${data.symbol}: ${error.message}`);
            }
        }

        logger.info(`✅ Exchange-listed tokens synced: ${result.success} successful`);

    } catch (error: any) {
        logger.error(`Exchange token sync failed: ${error.message}`);
        result.errors.push(error.message);
    } finally {
        await prisma.$disconnect();
    }

    return result;
}

/**
 * Populate contract addresses for existing tokens
 * Fetches from CoinPaprika and updates Token records
 */
export async function populateContractAddresses(): Promise<{ success: number, errors: string[] }> {
    const result = { success: 0, errors: [] as string[] };

    try {
        logger.info('📍 Populating contract addresses from CoinPaprika...');

        // Get symbol to CoinPaprika ID mapping
        const symbolToId = await getSymbolToIdMap();

        // Get all tokens without contract address
        const tokens = await prisma.token.findMany({
            where: { contractAddress: null },
            select: { id: true, symbol: true }
        });

        logger.info(`Found ${tokens.length} tokens without contract addresses`);

        let processed = 0;
        for (const token of tokens) {
            const coinId = symbolToId.get(token.symbol.toLowerCase());
            if (!coinId) continue;

            try {
                const contracts = await fetchContractAddresses(coinId);

                if (contracts.length > 0) {
                    // Prefer Ethereum, then Solana, then others
                    const preferred = contracts.find(c => c.chain === 'ethereum')
                        || contracts.find(c => c.chain === 'solana')
                        || contracts[0];

                    await prisma.token.update({
                        where: { id: token.id },
                        data: {
                            chain: preferred.chain,
                            contractAddress: preferred.contractAddress,
                            updatedAt: new Date()
                        }
                    });

                    result.success++;
                }

                processed++;
                if (processed % 50 === 0) {
                    logger.info(`Progress: ${processed}/${tokens.length} tokens processed, ${result.success} updated`);
                    // Small delay to avoid rate limiting
                    await new Promise(r => setTimeout(r, 100));
                }

            } catch (error: any) {
                result.errors.push(`Token ${token.symbol}: ${error.message}`);
            }
        }

        logger.info(`✅ Contract addresses populated: ${result.success} updated`);

    } catch (error: any) {
        logger.error(`Contract population failed: ${error.message}`);
        result.errors.push(error.message);
    } finally {
        await prisma.$disconnect();
    }

    return result;
}

/**
 * Populate on-chain analytics for tokens with contract addresses
 * Fetches liquidity, holder distribution, etc.
 */
export async function populateOnChainAnalytics(): Promise<{ success: number, errors: string[] }> {
    const result = { success: 0, errors: [] as string[] };

    try {
        logger.info('⛓️ Populating on-chain analytics...');

        // Get tokens with contract addresses
        const tokens = await prisma.token.findMany({
            where: {
                contractAddress: { not: null },
                chain: { in: ['ethereum', 'solana'] } // Only supported chains
            },
            select: {
                id: true,
                symbol: true,
                chain: true,
                contractAddress: true,
                coingeckoId: true
            }
        });

        logger.info(`Found ${tokens.length} tokens with contract addresses on supported chains`);

        for (const token of tokens) {
            try {
                const onChainData = await fetchOnChainData(
                    token.coingeckoId || '',
                    token.symbol,
                    token.contractAddress,
                    token.chain
                );

                if (onChainData) {
                    await prisma.token.update({
                        where: { id: token.id },
                        data: {
                            liquidityScore: onChainData.walletDistributionScore || undefined,
                            transferVolume24h: onChainData.transferVolume24h || undefined,
                            updatedAt: new Date()
                        }
                    });

                    result.success++;
                    logger.info(`Updated on-chain data for ${token.symbol}`);
                }

                // Rate limit delay
                await new Promise(r => setTimeout(r, 500));

            } catch (error: any) {
                result.errors.push(`Token ${token.symbol}: ${error.message}`);
            }
        }

        logger.info(`✅ On-chain analytics populated: ${result.success} updated`);

    } catch (error: any) {
        logger.error(`On-chain analytics failed: ${error.message}`);
        result.errors.push(error.message);
    } finally {
        await prisma.$disconnect();
    }

    return result;
}

/**
 * Record current prices to history for charting
 * Creates hourly snapshots of token prices
 */
export async function recordPriceHistory(): Promise<{ success: number, errors: string[] }> {
    const result = { success: 0, errors: [] as string[] };

    try {
        logger.info('📊 Recording price history...');

        // Get top 100 tokens by market cap
        const tokens = await prisma.token.findMany({
            where: {
                price: { not: null },
                marketCap: { gt: 0 }
            },
            orderBy: { marketCap: 'desc' },
            take: 100,
            select: {
                id: true,
                symbol: true,
                price: true,
                marketCap: true,
                volume24h: true
            }
        });

        logger.info(`Recording history for ${tokens.length} tokens`);

        const now = new Date();
        // Round to nearest hour
        now.setMinutes(0, 0, 0);

        for (const token of tokens) {
            try {
                await prisma.tokenHistory.upsert({
                    where: {
                        tokenId_interval_timestamp: {
                            tokenId: token.id,
                            interval: '1h',
                            timestamp: now
                        }
                    },
                    update: {
                        price: token.price,
                        close: token.price,
                        marketCap: token.marketCap,
                        volume24h: token.volume24h
                    },
                    create: {
                        tokenId: token.id,
                        interval: '1h',
                        timestamp: now,
                        open: token.price,
                        high: token.price,
                        low: token.price,
                        close: token.price,
                        price: token.price,
                        marketCap: token.marketCap,
                        volume24h: token.volume24h
                    }
                });

                result.success++;

            } catch (error: any) {
                result.errors.push(`Token ${token.symbol}: ${error.message}`);
            }
        }

        logger.info(`✅ Price history recorded: ${result.success} entries`);

    } catch (error: any) {
        logger.error(`Price history recording failed: ${error.message}`);
        result.errors.push(error.message);
    } finally {
        await prisma.$disconnect();
    }

    return result;
}

export default {
    populateTokenHeadersFromCoinPaprika,
    updateTokenPricesFromCoinCap,
    syncExchangeListedTokens,
    populateContractAddresses,
    populateOnChainAnalytics,
    recordPriceHistory
};
