import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { logger } from '../services/logger';
import { fetchMarketData, CoinGeckoToken } from '../api/coingecko';
import { fetchBitqueryTokens, BitqueryToken } from '../api/bitquery';
import { calculateTokenMetrics, TokenMetrics } from '../utils/tokenAnalytics';

const prisma = new PrismaClient();
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

export async function refreshTokens(req: Request, res: Response) {
  try {
    const coingeckoData = await fetchMarketData();
    const bitqueryTokens = await fetchBitqueryTokens();
    let coingeckoStatus = 'success';
    let bitqueryStatus = bitqueryTokens.length > 0 ? 'success' : 'failed';

    logger.info(`Fetched ${coingeckoData.length} tokens from CoinGecko`);
    logger.info(`Fetched ${bitqueryTokens.length} tokens from Bitquery`);

    const coingeckoMap = new Map<string, CoinGeckoToken>();
    for (const token of coingeckoData) {
      coingeckoMap.set(token.id, token);
      if (token.platforms?.solana) {
        coingeckoMap.set(token.platforms.solana, token);
      }
    }

    const allTokens: CoinGeckoToken[] = [
      ...coingeckoData,
      ...bitqueryTokens.map(b => ({
        id: b.coingeckoId || b.symbol.toLowerCase(),
        name: b.name,
        symbol: b.symbol.toLowerCase(),
        current_price: b.price,
        market_cap: null,
        total_supply: null,
        circulating_supply: null,
        total_volume: null,
        transferAmount: b.transferAmount,
        categories: undefined,
        platforms: undefined
      } as CoinGeckoToken))
    ];

    let upsertCount = 0;
    for (const token of allTokens) {
      const category = token.categories?.[0] || 'uncategorized';
      const symbol = token.symbol.toLowerCase();
      const cgToken = coingeckoMap.get(token.id) || (token.platforms?.solana ? coingeckoMap.get(token.platforms.solana) : undefined);

      const updatedToken = await prisma.token.upsert({
        where: { symbol },
        update: {
          name: token.name,
          category,
          price: token.current_price ?? (cgToken?.current_price ?? 0),
          marketCap: token.market_cap ?? (cgToken?.market_cap ?? 0),
          volume24h: token.total_volume ?? (cgToken?.total_volume ?? 0),
          transferVolume24h: token.transferAmount,
          updatedAt: new Date()
        },
        create: {
          name: token.name,
          symbol,
          category,
          price: token.current_price ?? (cgToken?.current_price ?? 0),
          marketCap: token.market_cap ?? (cgToken?.market_cap ?? 0),
          volume24h: token.total_volume ?? (cgToken?.total_volume ?? 0),
          transferVolume24h: token.transferAmount,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });

      // Save historical data
      await prisma.tokenHistory.create({
        data: {
          tokenId: updatedToken.id,
          price: token.current_price ?? (cgToken?.current_price ?? 0),
          marketCap: token.market_cap ?? (cgToken?.market_cap ?? 0),
          volume24h: token.total_volume ?? (cgToken?.total_volume ?? 0),
          timestamp: new Date()
        }
      });

      upsertCount++;
    }

    logger.info(`Upserted ${upsertCount} tokens and saved their historical data`);
    await prisma.$disconnect();
    res.json({ message: 'Token data refreshed successfully', coingeckoStatus, bitqueryStatus, totalUpserted: upsertCount });
  } catch (error: any) {
    logger.error(`Error refreshing tokens: ${error.message}`);
    await prisma.$disconnect();
    res.status(500).json({ error: 'Failed to refresh tokens' });
  }
}

export async function getTokens(req: Request, res: Response) {
  try {
    const { category } = req.query;
    const tokens = await prisma.token.findMany({
      where: category ? { category: category as string } : undefined,
      orderBy: { updatedAt: 'desc' }
    });

    logger.info(`Returning ${tokens.length} tokens from database`);
    const enrichedTokens = tokens.map(token => {
      const metrics = calculateTokenMetrics({
        price: token.price || 0,
        marketCap: token.marketCap || 0,
        volume24h: token.volume24h || 0,
        circulatingSupply: undefined,
        totalSupply: undefined,
        targetMarketCap: undefined
      });
      return {
        ...token,
        ...metrics
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
    const token = await prisma.token.findUnique({
      where: { id }
    });
    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }
    res.json(token);
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
      take: 100 // Limit to last 100 entries
    });
    res.json(history);
  } catch (error: any) {
    logger.error(`Error fetching token history for ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch token history' });
  }
}

export async function createToken(req: Request, res: Response) {
  try {
    const { name, symbol, category, price, marketCap, volume24h, transferVolume24h } = req.body;
    const token = await prisma.token.create({
      data: {
        name,
        symbol: symbol.toLowerCase(),
        category: category || 'uncategorized',
        price,
        marketCap,
        volume24h,
        transferVolume24h,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });
    res.status(201).json(token);
  } catch (error: any) {
    logger.error(`Error creating token: ${error.message}`);
    res.status(500).json({ error: 'Failed to create token' });
  }
}

export async function updateToken(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { name, symbol, category, price, marketCap, volume24h, transferVolume24h } = req.body;
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
        updatedAt: new Date()
      }
    });
    res.json(token);
  } catch (error: any) {
    logger.error(`Error updating token ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Failed to update token' });
  }
}

export async function deleteToken(req: Request, res: Response) {
  try {
    const { id } = req.params;
    await prisma.token.delete({
      where: { id }
    });
    res.status(204).send();
  } catch (error: any) {
    logger.error(`Error deleting token ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete token' });
  }
}