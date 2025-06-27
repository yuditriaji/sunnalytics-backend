// src/controllers/tokenController.ts
import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { logger } from '../services/logger';
import { cache } from '../services/cache';
import { fetchMarketData, fetchExchangeTokens, CoinGeckoToken } from '../api/coingecko';
import { fetchBitqueryTokens, BitqueryToken } from '../api/bitquery';
import { fetchOnChainData } from '../api/onchain';
import { calculateTokenMetrics, TokenMetrics } from '../utils/tokenAnalytics';
import axios from 'axios';

const prisma = new PrismaClient();
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

export async function refreshTokens(req: Request, res: Response) {
  try {
    // Fetch exchange tokens to identify Binance/Bybit listings
    const exchangeTokens = await fetchExchangeTokens(['binance', 'bybit_spot']);
    const exchangeTokenMap = new Map<string, string>(
      exchangeTokens.map((token) => [token.coinId, token.exchange])
    );

    // Fetch market data, filtering for Binance/Bybit tokens
    const coingeckoData = await fetchMarketData();
    const filteredTokens = coingeckoData
      .filter((token) => exchangeTokenMap.has(token.id))
      .slice(0, 750); // Limit to 750 tokens
    const bitqueryTokens = await fetchBitqueryTokens();
    let coingeckoStatus = filteredTokens.length > 0 ? 'success' : 'failed';
    let bitqueryStatus = bitqueryTokens.length > 0 ? 'success' : 'failed';

    logger.info(`Fetched ${filteredTokens.length} Binance/Bybit tokens from CoinGecko`);
    logger.info(`Fetched ${bitqueryTokens.length} tokens from Bitquery`);

    const coingeckoMap = new Map<string, CoinGeckoToken>();
    for (const token of filteredTokens) {
      coingeckoMap.set(token.id, token);
      if (token.platforms?.solana) coingeckoMap.set(token.platforms.solana, token);
      if (token.platforms?.ethereum) coingeckoMap.set(token.platforms.ethereum, token);
    }

    const allTokens: (CoinGeckoToken | BitqueryToken)[] = [
      ...filteredTokens,
      ...bitqueryTokens.filter((bt) => exchangeTokenMap.has(bt.coingeckoId || bt.symbol.toLowerCase())),
    ];

    let upsertCount = 0;
    const batchSize = 50;
    for (let i = 0; i < allTokens.length; i += batchSize) {
      const batch = allTokens.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (token) => {
          const isBitqueryToken = 'address' in token;
          const category = isBitqueryToken ? 'altcoin' : token.categories?.[0] || 'uncategorized';
          const symbol = isBitqueryToken ? token.symbol.toLowerCase() : token.symbol.toLowerCase();
          const cgToken = isBitqueryToken
            ? coingeckoMap.get(token.coingeckoId || symbol) || coingeckoMap.get(token.address)
            : coingeckoMap.get(token.id) ||
              (token.platforms?.solana ? coingeckoMap.get(token.platforms.solana) : undefined) ||
              (token.platforms?.ethereum ? coingeckoMap.get(token.platforms.ethereum) : undefined);

          // Fetch platforms and exchange from TokenHeader
          const tokenHeader = await prisma.tokenHeader.findFirst({
            where: { symbol },
            select: { platforms: true, exchange: true },
          });

          let contractAddress: string | undefined;
          let platform: string | undefined;

          if (isBitqueryToken) {
            contractAddress = token.address;
            platform = 'solana';
          } else if (tokenHeader?.platforms) {
            const platforms = tokenHeader.platforms as { [key: string]: string };
            if (platforms.ethereum) {
              contractAddress = platforms.ethereum;
              platform = 'ethereum';
            } else if (platforms.solana) {
              contractAddress = platforms.solana;
              platform = 'solana';
            } else {
              const firstPlatform = Object.keys(platforms)[0];
              if (firstPlatform && platforms[firstPlatform]) {
                contractAddress = platforms[firstPlatform];
                platform = firstPlatform;
              }
            }
          } else {
            contractAddress = token.platforms?.ethereum || token.platforms?.solana;
            platform = token.platforms?.ethereum
              ? 'ethereum'
              : token.platforms?.solana
              ? 'solana'
              : undefined;
          }

          if (!contractAddress || !platform) {
            logger.warn(`Skipping token ${symbol}: missing contractAddress or platform`);
            return;
          }

          logger.debug(`Selected platform ${platform} with contractAddress ${contractAddress} for ${symbol}`);

          const metrics = await calculateTokenMetrics({
            price: isBitqueryToken ? token.price : token.current_price ?? (cgToken?.current_price ?? 0),
            marketCap: isBitqueryToken ? 0 : token.market_cap ?? (cgToken?.market_cap ?? 0),
            volume24h: isBitqueryToken ? 0 : token.total_volume ?? (cgToken?.total_volume ?? 0),
            transferVolume24h: isBitqueryToken ? token.transferAmount : undefined,
            circulatingSupply: isBitqueryToken ? undefined : (token.circulating_supply ?? undefined),
            totalSupply: isBitqueryToken ? undefined : (token.total_supply ?? undefined),
            coingeckoId: isBitqueryToken ? token.coingeckoId : token.id,
            contractAddress,
            platform,
          });

          const exchange = exchangeTokenMap.get(isBitqueryToken ? token.coingeckoId || symbol : token.id) || tokenHeader?.exchange;

          if (!exchange) {
            logger.warn(`No exchange data for ${symbol}, skipping Token upsert`);
            return;
          }

          const updatedToken = await prisma.token.upsert({
            where: { symbol },
            update: {
              name: isBitqueryToken ? token.name : token.name,
              category,
              price: isBitqueryToken ? token.price : token.current_price ?? (cgToken?.current_price ?? 0),
              marketCap: isBitqueryToken ? 0 : token.market_cap ?? (cgToken?.market_cap ?? 0),
              volume24h: isBitqueryToken ? 0 : token.total_volume ?? (cgToken?.total_volume ?? 0),
              transferVolume24h: isBitqueryToken ? token.transferAmount : undefined,
              priceChange24h: isBitqueryToken ? undefined : token.price_change_percentage_24h ?? (cgToken?.price_change_percentage_24h ?? null),
              walletDistributionScore: metrics.walletDistributionScore,
              contractAddress,
              platform,
              exchange,
              updatedAt: new Date(),
            },
            create: {
              name: isBitqueryToken ? token.name : token.name,
              symbol,
              category,
              price: isBitqueryToken ? token.price : token.current_price ?? (cgToken?.current_price ?? 0),
              marketCap: isBitqueryToken ? 0 : token.market_cap ?? (cgToken?.market_cap ?? 0),
              volume24h: isBitqueryToken ? 0 : token.total_volume ?? (cgToken?.total_volume ?? 0),
              transferVolume24h: isBitqueryToken ? token.transferAmount : undefined,
              priceChange24h: isBitqueryToken ? null : token.price_change_percentage_24h ?? (cgToken?.price_change_percentage_24h ?? null),
              walletDistributionScore: metrics.walletDistributionScore,
              contractAddress,
              platform,
              exchange,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          });

          await prisma.tokenHistory.create({
            data: {
              tokenId: updatedToken.id,
              price: isBitqueryToken ? token.price : token.current_price ?? (cgToken?.current_price ?? 0),
              marketCap: isBitqueryToken ? 0 : token.market_cap ?? (cgToken?.market_cap ?? 0),
              volume24h: isBitqueryToken ? 0 : token.total_volume ?? (cgToken?.total_volume ?? 0),
              timestamp: new Date(),
            },
          });

          upsertCount++;
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    await updateTokenScores();

    logger.info(`Upserted ${upsertCount} tokens and saved their historical data`);
    await prisma.$disconnect();
    res.json({ message: 'Token data refreshed successfully', coingeckoStatus, bitqueryStatus, totalUpserted: upsertCount });
  } catch (error: any) {
    logger.error(`Error refreshing tokens: ${error.message}`);
    await prisma.$disconnect();
    res.status(500).json({ error: 'Failed to refresh tokens' });
  }
}

async function updateTokenScores() {
  try {
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

    logger.info('Updated liquidityScore and pumpDumpRiskScore in the database');
  } catch (error: any) {
    logger.error(`Error updating token scores: ${error.message}`);
    throw error;
  }
}

export async function getTokens(req: Request, res: Response) {
  try {
    const { category } = req.query;
    const tokens = await prisma.token.findMany({
      where: category ? { category: category as string } : undefined,
      orderBy: { updatedAt: 'desc' },
    });

    logger.info(`Returning ${tokens.length} tokens from database`);
    const enrichedTokens = tokens.map((token) => {
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
    const token = await prisma.token.findUnique({ where: { id } });
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
    const history = await prisma.tokenHistory.findMany({
      where: { tokenId: id },
      orderBy: { timestamp: 'asc' },
      take: 100,
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
    const token = await prisma.token.create({
      data: {
        name,
        symbol: symbol.toLowerCase(),
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
    const token = await prisma.token.update({
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
    await prisma.token.delete({ where: { id } });
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
          await prisma.tokenHeader.upsert({
            where: { id: token.id },
            update: {
              symbol: token.symbol.toLowerCase(),
              name: token.name,
              platforms: token.platforms || {},
              updatedAt: new Date(),
            },
            create: {
              id: token.id,
              symbol: token.symbol.toLowerCase(),
              name: token.name,
              platforms: token.platforms || {},
              exchange: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
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
    const exchangeTokens = await fetchExchangeTokens(['binance', 'bybit_spot']);
    let upsertCount = 0;
    const batchSize = 100;

    for (let i = 0; i < exchangeTokens.length; i += batchSize) {
      const batch = exchangeTokens.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (token) => {
          try {
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
                symbol: token.symbol.toLowerCase(),
                exchange: token.exchange,
                updatedAt: new Date(),
              },
              create: {
                id: token.coinId,
                symbol: token.symbol.toLowerCase(),
                name: token.symbol, // Fallback name
                platforms: {},
                exchange: token.exchange,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            });
            upsertCount++;
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
    // Fetch tokens with contractAddress, platform, and exchange
    const tokens = await prisma.token.findMany({
      where: { contractAddress: { not: null }, platform: { not: null }, exchange: { not: null } },
      select: { id: true, symbol: true, contractAddress: true, platform: true },
    });

    logger.info(`Found ${tokens.length} tokens with contractAddress, platform, and exchange`);

    let upsertCount = 0;
    const batchSize = 10;
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (token) => {
          logger.debug(`Processing token ${token.symbol} (${token.contractAddress}, ${token.platform})`);

          if (!token.contractAddress || !token.platform) {
            logger.warn(`Skipping token ${token.symbol}: missing contractAddress or platform`);
            return;
          }

          // Find corresponding TokenHeader
          const header = await prisma.tokenHeader.findFirst({
            where: { symbol: token.symbol.toLowerCase() },
            select: { id: true },
          });
          if (!header) {
            logger.warn(`No TokenHeader found for symbol ${token.symbol}`);
            return;
          }

          // Update Token with contractAddress and platform if needed
          await prisma.token.update({
            where: { id: token.id },
            data: {
              contractAddress: token.contractAddress,
              platform: token.platform,
            },
          });

          // Fetch on-chain data
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

          // Upsert TokenDetail
          await prisma.tokenDetail.upsert({
            where: { id: header.id },
            update: {
              symbol: token.symbol.toLowerCase(),
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
              symbol: token.symbol.toLowerCase(),
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
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Respect rate limits
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
    const details = await prisma.tokenDetail.findMany({
      select: {
        symbol: true,
        walletDistributionScore: true,
        poolLiquidity: true,
        transferVolume24h: true,
      },
    });

    let updateCount = 0;
    const batchSize = 50;
    for (let i = 0; i < details.length; i += batchSize) {
      const batch = details.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (detail) => {
          const token = await prisma.token.findUnique({
            where: { symbol: detail.symbol.toLowerCase() },
          });
          if (!token) {
            logger.warn(`No Token found for symbol ${detail.symbol}`);
            return;
          }

          // Calculate liquidityScore based on poolLiquidity
          const liquidityScore = detail.poolLiquidity
            ? Math.min((detail.poolLiquidity / 1000000) * 100, 100) // Normalize to 0-100
            : token.liquidityScore;

          // Update Token
          await prisma.token.update({
            where: { symbol: detail.symbol.toLowerCase() },
            data: {
              walletDistributionScore: detail.walletDistributionScore,
              transferVolume24h: detail.transferVolume24h,
              liquidityScore,
              updatedAt: new Date(),
            },
          });
          updateCount++;
        })
      );
    }

    // Recalculate scores
    await updateTokenScores();

    logger.info(`Updated ${updateCount} tokens in Token table`);
    res.json({ status: 'success', tokens: updateCount });
  } catch (error: any) {
    logger.error(`Error updating Token table: ${error.message}`);
    res.status(500).json({ error: 'Failed to update Token table' });
  }
}
