"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshTokens = exports.deleteToken = exports.updateToken = exports.createToken = exports.getTokenById = exports.getTokens = void 0;
const prisma_1 = require("../services/prisma");
const cache_1 = require("../services/cache");
const logger_1 = require("../services/logger");
const coingecko_1 = require("../api/coingecko");
const bitquery_1 = require("../api/bitquery");
const tokenAnalytics_1 = require("../utils/tokenAnalytics");
const validation_1 = require("../utils/validation");
const getTokens = async (req, res) => {
    const { category } = req.query;
    try {
        if (category && !['memecoin', 'defi', 'altcoin'].includes(category)) {
            return res.status(400).json({ error: 'Invalid category. Use memecoin, defi, or altcoin.' });
        }
        const cacheKey = category ? `tokens_${category}` : 'tokens_all';
        const cachedData = cache_1.cache.get(cacheKey);
        let marketData = [];
        if (!cachedData) {
            marketData = await (0, coingecko_1.fetchMarketData)();
            cache_1.cache.set(cacheKey, marketData, 300);
        }
        else {
            marketData = cachedData;
        }
        const where = category ? { category: category } : {};
        const tokens = await prisma_1.prisma.token.findMany({ where });
        const enrichedTokens = tokens.map(token => {
            const marketInfo = marketData.find(m => m.symbol.toLowerCase() === token.symbol.toLowerCase());
            if (marketInfo) {
                const metrics = (0, tokenAnalytics_1.calculateTokenMetrics)({
                    price: token.price ?? marketInfo.current_price,
                    marketCap: token.marketCap ?? marketInfo.market_cap,
                    volume24h: token.volume24h ?? marketInfo.total_volume,
                    circulatingSupply: marketInfo.circulating_supply,
                    totalSupply: marketInfo.total_supply
                });
                return {
                    ...token,
                    ...metrics,
                    price: token.price ?? marketInfo.current_price,
                    marketCap: token.marketCap ?? marketInfo.market_cap,
                    volume24h: token.volume24h ?? marketInfo.total_volume
                };
            }
            return token;
        });
        res.json(enrichedTokens);
    }
    catch (error) {
        logger_1.logger.error(`Error fetching tokens: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch tokens' });
    }
};
exports.getTokens = getTokens;
const getTokenById = async (req, res) => {
    try {
        const { id } = req.params;
        const token = await prisma_1.prisma.token.findUnique({ where: { id } });
        if (!token) {
            return res.status(404).json({ error: 'Token not found' });
        }
        res.json(token);
    }
    catch (error) {
        logger_1.logger.error(`Error fetching token ${req.params.id}: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch token' });
    }
};
exports.getTokenById = getTokenById;
const createToken = async (req, res) => {
    try {
        const data = validation_1.tokenSchema.parse(req.body);
        const newToken = await prisma_1.prisma.token.create({
            data: {
                name: data.name,
                symbol: data.symbol,
                category: data.category,
                marketCap: data.marketCap ?? null,
                volume24h: data.volume24h ?? null,
                price: data.price ?? null
            }
        });
        res.status(201).json(newToken);
    }
    catch (error) {
        logger_1.logger.error(`Error creating token: ${error.message}`);
        res.status(400).json({ error: 'Failed to create token', details: error.errors || error.message });
    }
};
exports.createToken = createToken;
const updateToken = async (req, res) => {
    try {
        const { id } = req.params;
        const data = validation_1.tokenSchema.parse(req.body);
        const updatedToken = await prisma_1.prisma.token.update({
            where: { id },
            data: {
                name: data.name,
                symbol: data.symbol,
                category: data.category,
                marketCap: data.marketCap ?? null,
                volume24h: data.volume24h ?? null,
                price: data.price ?? null
            }
        });
        res.json(updatedToken);
    }
    catch (error) {
        logger_1.logger.error(`Error updating token ${req.params.id}: ${error.message}`);
        res.status(400).json({ error: 'Failed to update token', details: error.errors || error.message });
    }
};
exports.updateToken = updateToken;
const deleteToken = async (req, res) => {
    try {
        const { id } = req.params;
        await prisma_1.prisma.token.delete({ where: { id } });
        res.status(204).send();
    }
    catch (error) {
        logger_1.logger.error(`Error deleting token ${req.params.id}: ${error.message}`);
        res.status(500).json({ error: 'Failed to delete token' });
    }
};
exports.deleteToken = deleteToken;
const refreshTokens = async (req, res) => {
    try {
        let coingeckoData = [];
        let bitqueryData = [];
        // Fetch CoinGecko data
        try {
            coingeckoData = await (0, coingecko_1.fetchMarketData)();
            cache_1.cache.set('tokens_all', coingeckoData, 300);
        }
        catch (error) {
            logger_1.logger.error(`CoinGecko fetch failed: ${error.message}`);
        }
        // Fetch Bitquery data
        try {
            bitqueryData = await (0, bitquery_1.fetchBitqueryTokens)();
            cache_1.cache.set('bitquery_tokens', bitqueryData, 300);
        }
        catch (error) {
            logger_1.logger.error(`Bitquery fetch failed: ${error.message}`);
        }
        // Update database with CoinGecko data
        if (coingeckoData.length > 0) {
            for (const token of coingeckoData) {
                await prisma_1.prisma.token.upsert({
                    where: { symbol: token.symbol },
                    update: {
                        name: token.name,
                        price: Number(token.current_price) || null,
                        marketCap: Number(token.market_cap) || null,
                        volume24h: Number(token.total_volume) || null
                    },
                    create: {
                        name: token.name,
                        symbol: token.symbol,
                        category: 'altcoin',
                        price: Number(token.current_price) || null,
                        marketCap: Number(token.market_cap) || null,
                        volume24h: Number(token.total_volume) || null
                    }
                });
            }
        }
        // Update database with Bitquery data
        if (bitqueryData.length > 0) {
            for (const token of bitqueryData) {
                await prisma_1.prisma.token.upsert({
                    where: { symbol: token.symbol },
                    update: {
                        name: token.name,
                        price: Number(token.price) || null
                    },
                    create: {
                        name: token.name,
                        symbol: token.symbol,
                        category: 'bitcoin',
                        price: Number(token.price) || null
                    }
                });
            }
        }
        res.json({
            message: 'Token data refreshed successfully',
            coingeckoStatus: coingeckoData.length > 0 ? 'success' : 'failed',
            bitqueryStatus: bitqueryData.length > 0 ? 'success' : 'failed'
        });
    }
    catch (error) {
        logger_1.logger.error(`Error refreshing tokens: ${error.message}`);
        res.status(500).json({ error: 'Failed to refresh tokens' });
    }
};
exports.refreshTokens = refreshTokens;
