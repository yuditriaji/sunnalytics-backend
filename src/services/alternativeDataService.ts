import { PrismaClient } from '@prisma/client';
import { logger } from './logger';
import { fetchTokenList, fetchMarketDataBatch } from '../api/alternativeData';

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
                await prisma.token.upsert({
                    where: { symbol: data.symbol.toLowerCase() },
                    update: {
                        name: data.name,
                        price: data.price,
                        marketCap: data.marketCap,
                        volume24h: data.volume24h,
                        priceChange24h: data.priceChange24h,
                        updatedAt: new Date()
                    },
                    create: {
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

export default {
    populateTokenHeadersFromCoinPaprika,
    updateTokenPricesFromCoinCap
};
