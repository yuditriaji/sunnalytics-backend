import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { logger } from '../services/logger';
import { fetchBitqueryTokens, BitqueryToken } from '../api/bitquery';
import axios from 'axios';

const prisma = new PrismaClient();
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

async function fetchCoinGeckoData(): Promise<any[]> {
  try {
    const response = await axios.get(`${COINGECKO_BASE}/coins/markets`, {
      params: {
        vs_currency: 'usd',
        per_page: 100,
        page: 1,
        price_change_percentage: '24h'
      },
      timeout: 5000
    });
    logger.info('CoinGecko API call successful, attempt 1');
    return response.data;
  } catch (error: any) {
    logger.error(`CoinGecko API error: ${error.message}`);
    throw error;
  }
}

export async function refreshTokens(req: Request, res: Response) {
  try {
    const coingeckoData = await fetchCoinGeckoData();
    const bitqueryTokens = await fetchBitqueryTokens();
    let coingeckoStatus = 'success';
    let bitqueryStatus = bitqueryTokens.length > 0 ? 'success' : 'failed';

    const coingeckoMap = new Map<string, any>();
    for (const token of coingeckoData) {
      coingeckoMap.set(token.id, token);
      if (token.platforms?.solana) {
        coingeckoMap.set(token.platforms.solana, token);
      }
    }

    for (const token of coingeckoData.concat(bitqueryTokens.map(b => ({
      id: b.coingeckoId || b.symbol.toLowerCase(),
      name: b.name,
      symbol: b.symbol.toLowerCase(),
      platforms: { solana: b.address },
      market_cap: null,
      total_volume: null,
      current_price: b.price,
      price_change_percentage_24h: null
    })))) {
      const bitqueryToken = bitqueryTokens.find(b => b.address === token.platforms?.solana || b.symbol.toLowerCase() === token.symbol);
      const cgToken = coingeckoMap.get(token.id) || coingeckoMap.get(token.platforms?.solana);

      const symbol = token.symbol.toLowerCase(); // Normalize symbol
      await prisma.token.upsert({
        where: { symbol },
        update: {
          name: token.name,
          category: token.platforms?.solana ? 'altcoin' : (cgToken?.category || 'altcoin'),
          price: bitqueryToken?.price ?? token.current_price,
          marketCap: cgToken?.market_cap,
          volume24h: cgToken?.total_volume,
          transferVolume24h: bitqueryToken?.transferAmount,
          updatedAt: new Date()
        },
        create: {
          name: token.name,
          symbol,
          category: token.platforms?.solana ? 'altcoin' : (cgToken?.category || 'altcoin'),
          price: bitqueryToken?.price ?? token.current_price,
          marketCap: cgToken?.market_cap,
          volume24h: cgToken?.total_volume,
          transferVolume24h: bitqueryToken?.transferAmount,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });
    }

    // Delete outdated USDC entry
    await prisma.token.deleteMany({
      where: {
        symbol: 'USDC',
        id: 'd5549ba5-643d-47a1-bafc-2d515a06e8f6'
      }
    });

    await prisma.$disconnect();
    res.json({ message: 'Token data refreshed successfully', coingeckoStatus, bitqueryStatus });
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
    res.json(tokens);
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

export async function createToken(req: Request, res: Response) {
  try {
    const { name, symbol, category, price, marketCap, volume24h, transferVolume24h } = req.body;
    const token = await prisma.token.create({
      data: {
        name,
        symbol: symbol.toLowerCase(),
        category: category || 'altcoin',
        price,
        marketCap,
        volume24h,
        transferVolume24h
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
        category,
        price,
        marketCap,
        volume24h,
        transferVolume24h
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