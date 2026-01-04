import { Request, Response } from 'express';
import { logger } from '../services/logger';
import { cache } from '../services/cache';
import { fetchMarketData, fetchExchangeTokens, CoinGeckoToken } from '../api/coingecko';
import { fetchBitqueryTokens, BitqueryToken } from '../api/bitquery';
import { fetchOnChainData } from '../api/onchain';
import { calculateTokenMetrics, TokenMetrics } from '../utils/tokenAnalytics';
import { withDatabase } from '../services/database';
import { populateTokenHeadersFromCoinPaprika, updateTokenPricesFromCoinCap } from '../services/alternativeDataService';
import axios from 'axios';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

export async function refreshTokens(req: Request, res: Response) {
  try {
    // Import the new data pipeline
    const { dataPipeline } = await import('../services/dataPipeline');
    const { rateLimiter } = await import('../services/rateLimiter');

    logger.info('🚀 Starting comprehensive data pipeline with rate limiting');

    // Run the comprehensive data pipeline
    const stats = await dataPipeline.runComprehensivePipeline();

    // Get rate limiter status
    const rateLimiterStatus = rateLimiter.getStatus();

    // Get data quality report
    const qualityReport = await dataPipeline.getQualityReport();

    const response = {
      message: 'Comprehensive data pipeline completed successfully',
      status: 'success',
      pipeline: {
        duration: stats.endTime ?
          `${Math.round((stats.endTime.getTime() - stats.startTime.getTime()) / 1000)}s` : 'ongoing',
        processed: stats.totalProcessed,
        successful: stats.successfulUpserts,
        failures: stats.failures,
        dataQualityIssues: stats.dataQualityIssues
      },
      phases: {
        tokenHeaders: {
          processed: stats.phases.tokenHeaders.processed,
          success: stats.phases.tokenHeaders.success,
          errors: stats.phases.tokenHeaders.errors.length
        },
        exchangeData: {
          processed: stats.phases.exchangeData.processed,
          success: stats.phases.exchangeData.success,
          errors: stats.phases.exchangeData.errors.length
        },
        marketData: {
          processed: stats.phases.marketData.processed,
          success: stats.phases.marketData.success,
          errors: stats.phases.marketData.errors.length
        },
        blockchainData: {
          processed: stats.phases.onchainData.processed,
          success: stats.phases.onchainData.success,
          errors: stats.phases.onchainData.errors.length
        },
        tokenDetails: {
          processed: stats.phases.tokenDetails.processed,
          success: stats.phases.tokenDetails.success,
          errors: stats.phases.tokenDetails.errors.length
        }
      },
      dataQuality: {
        totalTokens: qualityReport.totalTokens,
        validTokens: qualityReport.validTokens,
        qualityScore: `${qualityReport.qualityScore.toFixed(1)}%`,
        missingPrices: qualityReport.missingPrices,
        missingMarketCaps: qualityReport.missingMarketCaps,
        missingContractAddresses: qualityReport.missingContractAddresses
      },
      rateLimiting: {
        coingecko: {
          status: rateLimiterStatus.coingecko.isCircuitOpen ? 'circuit-open' : 'operational',
          requestsLastMinute: rateLimiterStatus.coingecko.requestsInLastMinute,
          consecutiveFailures: rateLimiterStatus.coingecko.consecutiveFailures
        },
        solana: {
          status: rateLimiterStatus.solana.isCircuitOpen ? 'circuit-open' : 'operational',
          requestsLastMinute: rateLimiterStatus.solana.requestsInLastMinute,
          consecutiveFailures: rateLimiterStatus.solana.consecutiveFailures
        }
      }
    };

    res.json(response);

  } catch (error: any) {
    logger.error(`Comprehensive data pipeline failed: ${error.message}`);
    res.status(500).json({
      error: 'Data pipeline failed',
      message: error.message,
      status: 'failed'
    });
  }
}

/**
 * Alternative refresh using CoinPaprika/CoinCap (no rate limits)
 * Use this when CoinGecko is rate limited
 */
export async function refreshTokensAlternative(req: Request, res: Response) {
  try {
    logger.info('🚀 Starting alternative data pipeline (CoinPaprika/CoinCap - no rate limits)');

    const startTime = Date.now();

    // Populate token headers from CoinPaprika
    const headerResult = await populateTokenHeadersFromCoinPaprika();

    // Update prices from CoinCap
    const priceResult = await updateTokenPricesFromCoinCap();

    const duration = Math.round((Date.now() - startTime) / 1000);

    res.json({
      message: 'Alternative data pipeline completed successfully',
      status: 'success',
      duration: `${duration}s`,
      sources: {
        tokenHeaders: {
          source: 'CoinPaprika',
          success: headerResult.success,
          errors: headerResult.errors.length
        },
        marketData: {
          source: 'CoinCap',
          success: priceResult.success,
          errors: priceResult.errors.length
        }
      }
    });

  } catch (error: any) {
    logger.error(`Alternative data pipeline failed: ${error.message}`);
    res.status(500).json({
      error: 'Alternative data pipeline failed',
      message: error.message,
      status: 'failed'
    });
  }
}

async function updateTokenScores() {
  try {
    await withDatabase(async (prisma) => {
      await prisma.$executeRaw`
      UPDATE "Token"
      SET "liquidityScore" = LEAST(GREATEST(
        COALESCE(
          ((COALESCE("volume24h", 0) / NULLIF("marketCap", 0) * 0.7) +
           (COALESCE("transferVolume24h", 0) / NULLIF("marketCap", 0) * 0.3)) * 100,
          0
        ),
        0
      ), 100)
      WHERE "marketCap" IS NOT NULL AND "marketCap" > 0;
      `;

      await prisma.$executeRaw`
      WITH PriceChanges AS (
        SELECT
          "tokenId",
          "timestamp",
          "volume24h",
          "price",
          ("price" - LAG("price") OVER (PARTITION BY "tokenId" ORDER BY "timestamp"))
            / NULLIF(LAG("price") OVER (PARTITION BY "tokenId" ORDER BY "timestamp"), 0) AS price_change_ratio
        FROM "TokenHistory"
        WHERE "timestamp" >= NOW() - INTERVAL '7 days'
      ),
      HistoricalData AS (
        SELECT
          "tokenId",
          AVG("volume24h") AS avg_volume,
          STDDEV_POP(COALESCE(price_change_ratio, 0)) AS price_volatility
        FROM PriceChanges
        GROUP BY "tokenId"
        HAVING COUNT(*) >= 3
      )
      UPDATE "Token" t
      SET "pumpDumpRiskScore" = LEAST(GREATEST(
        COALESCE(
          (
            (COALESCE(t."volume24h", 0) - COALESCE(h.avg_volume, 0)) / NULLIF(h.avg_volume, 0) * 0.5 +
            COALESCE(h.price_volatility, 0) * 0.5
          ) * 100,
          0
        ),
        0
      ), 100)
      FROM HistoricalData h
      WHERE t.id = h."tokenId"
      AND t."marketCap" IS NOT NULL AND t."marketCap" > 0
      AND h.avg_volume IS NOT NULL AND h.avg_volume > 0;
      `;
    });

    logger.info('Updated liquidityScore and pumpDumpRiskScore in the database');
  } catch (error: any) {
    logger.error(`Error updating token scores: ${error.message}`);
    throw error;
  }
}

export async function getTokens(req: Request, res: Response) {
  try {
    const { category, exchange } = req.query;
    const tokens = await withDatabase(async (prisma) => {
      return await prisma.token.findMany({
        where: {
          category: category ? { equals: category as string } : undefined,
          exchange: exchange ? { contains: exchange as string } : undefined,
        },
        orderBy: { updatedAt: 'desc' },
      });
    });

    logger.info(`Returning ${tokens.length} tokens from database`);
    const enrichedTokens = tokens.map((token: any) => {
      const volumeMarketCapRatio = token.marketCap && token.marketCap > 0 ? (token.volume24h || 0) / token.marketCap : 0;

      return {
        id: token.id,
        symbol: token.symbol,
        name: token.name,
        category: token.category,
        price: token.price,
        marketCap: token.marketCap,
        volume24h: token.volume24h,
        volumeMarketCapRatio,
        liquidityScore: token.liquidityScore || 0,
        pumpDumpRiskScore: token.pumpDumpRiskScore || 0,
        walletDistributionScore: token.walletDistributionScore || 0,
        transferVolume24h: token.transferVolume24h || 0,
        isVolumeHealthy: volumeMarketCapRatio > 0.1,
        stats: {
          priceChange24h: token.priceChange24h || 0,
          liquidityScore: token.liquidityScore || 0,
        },
        exchange: token.exchange,
        updatedAt: token.updatedAt,
      };
    });

    res.json(enrichedTokens);
  } catch (error: any) {
    logger.error(`Error fetching tokens: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch tokens' });
  }
}

export async function getTokenById(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const token = await withDatabase(async (prisma) => {
      return await prisma.token.findUnique({ where: { id } });
    });
    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }

    const volumeMarketCapRatio = token.marketCap && token.marketCap > 0 ? (token.volume24h || 0) / token.marketCap : 0;

    res.json({
      id: token.id,
      symbol: token.symbol,
      name: token.name,
      category: token.category,
      price: token.price,
      marketCap: token.marketCap,
      volume24h: token.volume24h,
      volumeMarketCapRatio,
      liquidityScore: token.liquidityScore || 0,
      pumpDumpRiskScore: token.pumpDumpRiskScore || 0,
      walletDistributionScore: token.walletDistributionScore || 0,
      isVolumeHealthy: volumeMarketCapRatio > 0.1,
      stats: {
        priceChange24h: token.priceChange24h || 0,
        liquidityScore: token.liquidityScore || 0,
      },
      exchange: token.exchange,
    });
  } catch (error: any) {
    logger.error(`Error fetching token ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch token' });
  }
}

export async function getTokenHistory(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const history = await withDatabase(async (prisma) => {
      return await prisma.tokenHistory.findMany({
        where: { tokenId: id },
        orderBy: { timestamp: 'asc' },
        take: 100,
      });
    });
    res.json(history);
  } catch (error: any) {
    logger.error(`Error fetching token history for ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch token history' });
  }
}

export async function createToken(req: Request, res: Response) {
  try {
    const { name, symbol, category, price, marketCap, volume24h, transferVolume24h, priceChange24h, walletDistributionScore, exchange } = req.body;
    const token = await withDatabase(async (prisma) => {
      return await prisma.token.create({
        data: {
          name,
          symbol: symbol ? symbol.toLowerCase() : '',
          category: category || 'uncategorized',
          price,
          marketCap,
          volume24h,
          transferVolume24h,
          priceChange24h,
          walletDistributionScore,
          exchange,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });

    await updateTokenScores();
    res.status(201).json(token);
  } catch (error: any) {
    logger.error(`Error creating token: ${error.message}`);
    res.status(500).json({ error: 'Failed to create token' });
  }
}

export async function updateToken(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { name, symbol, category, price, marketCap, volume24h, transferVolume24h, priceChange24h, walletDistributionScore, exchange } = req.body;
    const token = await withDatabase(async (prisma) => {
      return await prisma.token.update({
        where: { id },
        data: {
          name,
          symbol: symbol?.toLowerCase(),
          category: category || 'uncategorized',
          price,
          marketCap,
          volume24h,
          transferVolume24h,
          priceChange24h,
          walletDistributionScore,
          exchange,
          updatedAt: new Date(),
        },
      });
    });

    await updateTokenScores();
    res.json(token);
  } catch (error: any) {
    logger.error(`Error updating token ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Failed to update token' });
  }
}

export async function deleteToken(req: Request, res: Response) {
  try {
    const { id } = req.params;
    await withDatabase(async (prisma) => {
      await prisma.token.delete({ where: { id } });
    });
    res.status(204).send();
  } catch (error: any) {
    logger.error(`Error deleting token ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete token' });
  }
}

export async function populateHeader(req: Request, res: Response) {
  try {
    const cacheKey = 'coingecko_token_list';
    let tokens = cache.get<any[]>(cacheKey);

    if (!tokens) {
      logger.info('Fetching CoinGecko token list');
      const response = await axios.get(`${COINGECKO_BASE}/coins/list`, {
        params: { include_platform: true },
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      tokens = response.data;
      cache.set(cacheKey, tokens, 86400); // Cache for 24 hours
    }

    let upsertCount = 0;
    const batchSize = 100;
    if (!tokens) {
      logger.error('No tokens available to upsert into TokenHeader');
      return res.status(500).json({ error: 'No tokens available to upsert into TokenHeader' });
    }
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (token: any) => {
          await withDatabase(async (prisma) => {
            await prisma.tokenHeader.upsert({
              where: { id: token.id },
              update: {
                symbol: token.symbol ? token.symbol.toLowerCase() : '',
                name: token.name,
                platforms: token.platforms || {},
                updatedAt: new Date(),
              },
              create: {
                id: token.id,
                symbol: token.symbol ? token.symbol.toLowerCase() : '',
                name: token.name,
                platforms: token.platforms || {},
                exchange: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            });
          });
          upsertCount++;
        })
      );
    }

    logger.info(`Upserted ${upsertCount} tokens into TokenHeader`);
    res.json({ status: 'success', tokens: upsertCount });
  } catch (error: any) {
    logger.error(`Error populating TokenHeader: ${error.message}`);
    res.status(500).json({ error: 'Failed to populate TokenHeader' });
  }
}

export async function populateExchangeTokens(req: Request, res: Response) {
  try {
    const exchanges = ['binance', 'bybit_spot', 'mexc', 'huobi', 'gate'];
    const exchangeTokens = await fetchExchangeTokens(exchanges);
    let upsertCount = 0;
    const batchSize = 100;

    for (let i = 0; i < exchangeTokens.length; i += batchSize) {
      const batch = exchangeTokens.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (token) => {
          try {
            await withDatabase(async (prisma) => {
              // Verify TokenHeader exists
              const existingHeader = await prisma.tokenHeader.findUnique({
                where: { id: token.coinId },
              });

              if (!existingHeader) {
                logger.warn(`No TokenHeader found for coinId ${token.coinId}, creating new entry`);
              }

              await prisma.tokenHeader.upsert({
                where: { id: token.coinId },
                update: {
                  symbol: token.symbol ? token.symbol.toLowerCase() : '',
                  exchange: token.exchange,
                  updatedAt: new Date(),
                },
                create: {
                  id: token.coinId,
                  symbol: token.symbol ? token.symbol.toLowerCase() : '',
                  name: token.symbol, // Fallback name
                  platforms: {},
                  exchange: token.exchange,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              });
              upsertCount++;
            });
          } catch (error: any) {
            logger.warn(`Failed to upsert token ${token.coinId}: ${error.message}`);
          }
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Respect rate limits
    }

    logger.info(`Upserted ${upsertCount} exchange tokens into TokenHeader`);
    res.json({ status: 'success', tokens: upsertCount });
  } catch (error: any) {
    logger.error(`Error populating exchange tokens: ${error.message}`);
    res.status(500).json({ error: 'Failed to populate exchange tokens' });
  }
}

export async function populateDetail(req: Request, res: Response) {
  try {
    const tokens = await withDatabase(async (prisma) => {
      return await prisma.token.findMany({
        where: { contractAddress: { not: null }, platform: { not: null } }, // Removed exchange filter
        select: { id: true, symbol: true, contractAddress: true, platform: true },
        take: 1000, // Increased limit
      });
    });

    logger.info(`Found ${tokens.length} tokens with contractAddress and platform`);

    let upsertCount = 0;
    const batchSize = 5; // Reduced batch size
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (token: any) => {
          logger.debug(`Processing token ${token.symbol} (${token.contractAddress}, ${token.platform})`);

          if (!token.contractAddress || !token.platform) {
            logger.warn(`Skipping token ${token.symbol}: missing contractAddress or platform`);
            return;
          }

          await withDatabase(async (prisma) => {
            const header = await prisma.tokenHeader.findFirst({
              where: { symbol: token.symbol ? token.symbol.toLowerCase() : '' },
              select: { id: true },
            });
            if (!header) {
              logger.warn(`No TokenHeader found for symbol ${token.symbol}`);
              return;
            }

            await prisma.token.update({
              where: { id: token.id },
              data: {
                contractAddress: token.contractAddress,
                platform: token.platform,
              },
            });

            const onChainData = await fetchOnChainData(
              header.id,
              token.symbol,
              token.contractAddress,
              token.platform
            );
            if (!onChainData) {
              logger.warn(`No on-chain data for ${token.symbol}`);
              return;
            }

            logger.debug(`On-chain data for ${token.symbol}: ${JSON.stringify(onChainData)}`);

            await prisma.tokenDetail.upsert({
              where: { id: header.id },
              update: {
                symbol: token.symbol ? token.symbol.toLowerCase() : '',
                platform: token.platform,
                contractAddress: token.contractAddress,
                walletDistributionScore: onChainData.walletDistributionScore,
                poolLiquidity: onChainData.poolLiquidity,
                txActivityScore: onChainData.txActivityScore,
                transferVolume24h: onChainData.transferVolume24h,
                updatedAt: new Date(),
              },
              create: {
                id: header.id,
                symbol: token.symbol ? token.symbol.toLowerCase() : '',
                platform: token.platform,
                contractAddress: token.contractAddress,
                walletDistributionScore: onChainData.walletDistributionScore,
                poolLiquidity: onChainData.poolLiquidity,
                txActivityScore: onChainData.txActivityScore,
                transferVolume24h: onChainData.transferVolume24h,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            });
            upsertCount++;
            logger.info(`Upserted TokenDetail for ${token.symbol}`);
          });
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 2000)); // 2-4s delay
    }

    logger.info(`Upserted ${upsertCount} tokens into TokenDetail`);
    res.json({ status: 'success', tokens: upsertCount });
  } catch (error: any) {
    logger.error(`Error populating TokenDetail: ${error.message}`);
    res.status(500).json({ error: 'Failed to populate TokenDetail' });
  }
}

export async function updateTokenFromDetail(req: Request, res: Response) {
  try {
    const details = await withDatabase(async (prisma) => {
      return await prisma.tokenDetail.findMany({
        select: {
          symbol: true,
          walletDistributionScore: true,
          poolLiquidity: true,
          txActivityScore: true,
          transferVolume24h: true,
        },
      });
    });

    let updateCount = 0;
    const batchSize = 50;
    for (let i = 0; i < details.length; i += batchSize) {
      const batch = details.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (detail: any) => {
          await withDatabase(async (prisma) => {
            const token = await prisma.token.findUnique({
              where: { symbol: detail.symbol ? detail.symbol.toLowerCase() : '' },
            });
            if (!token) {
              logger.warn(`No Token found for symbol ${detail.symbol}`);
              return;
            }

            const liquidityScore = detail.poolLiquidity
              ? Math.min((detail.poolLiquidity / 1000000) * 100, 100)
              : token.liquidityScore || 0;

            await prisma.token.update({
              where: { symbol: detail.symbol ? detail.symbol.toLowerCase() : '' },
              data: {
                walletDistributionScore: detail.walletDistributionScore || 0,
                transferVolume24h: detail.transferVolume24h || 0,
                liquidityScore,
                updatedAt: new Date(),
              },
            });
            updateCount++;
          });
        })
      );
    }

    await updateTokenScores();

    logger.info(`Updated ${updateCount} tokens in Token table`);
    res.json({ status: 'success', tokens: updateCount });
  } catch (error: any) {
    logger.error(`Error updating Token table: ${error.message}`);
    res.status(500).json({ error: 'Failed to update Token table' });
  }
}