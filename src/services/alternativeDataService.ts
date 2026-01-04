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
 * Update token prices using CoinCap (no rate limits)
 */
export async function updateTokenPricesFromCoinCap(): Promise<{ success: number, errors: string[] }> {
    const result = { success: 0, errors: [] as string[] };

    try {
        logger.info('💰 Fetching market data from CoinCap (200 req/min, no key)...');

        // Fetch market data
        const marketData = await fetchMarketDataBatch(2000);
        const priceMap = new Map(
            marketData.map(d => [d.symbol.toLowerCase(), d])
        );

        // Get all tokens
        const tokens = await prisma.token.findMany({
            select: { id: true, symbol: true }
        });

        logger.info(`Updating prices for ${tokens.length} tokens...`);

        for (const token of tokens) {
            const data = priceMap.get(token.symbol.toLowerCase());
            if (!data) continue;

            try {
                await prisma.token.update({
                    where: { id: token.id },
                    data: {
                        price: data.price,
                        marketCap: data.marketCap,
                        volume24h: data.volume24h,
                        priceChange24h: data.priceChange24h,
                        updatedAt: new Date()
                    }
                });

                result.success++;

            } catch (error: any) {
                result.errors.push(`Token ${token.symbol}: ${error.message}`);
            }
        }

        logger.info(`✅ Token prices updated: ${result.success} successful`);

    } catch (error: any) {
        logger.error(`Price update failed: ${error.message}`);
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
