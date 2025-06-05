"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const client_1 = require("@prisma/client");
const coingecko_1 = require("../api/coingecko");
const cache_1 = require("../services/cache");
const tokenAnalytics_1 = require("../utils/tokenAnalytics");
const router = express_1.default.Router();
const prisma = new client_1.PrismaClient();
// Get all altcoins with market data and analytics
router.get('/', async (req, res) => {
    try {
        // Try to get from cache first
        const cachedData = cache_1.cache.get('altcoins_market_data');
        let marketData;
        if (!cachedData) {
            // Fetch fresh data from CoinGecko
            marketData = await (0, coingecko_1.fetchMarketData)();
            cache_1.cache.set('altcoins_market_data', marketData, 300); // Cache for 5 minutes
        }
        else {
            marketData = cachedData;
        }
        // Get database records
        const altcoins = await prisma.token.findMany({
            where: { category: 'altcoin' }
        });
        // Enrich database records with market data and analytics
        const enrichedAltcoins = altcoins.map(token => {
            const marketInfo = marketData.find(m => m.symbol.toLowerCase() === token.symbol.toLowerCase());
            if (marketInfo) {
                const metrics = (0, tokenAnalytics_1.calculateTokenMetrics)({
                    price: token.price || marketInfo.current_price,
                    marketCap: token.marketCap || marketInfo.market_cap,
                    volume24h: token.volume24h || marketInfo.total_volume,
                    circulatingSupply: marketInfo.circulating_supply,
                    totalSupply: marketInfo.total_supply
                });
                return {
                    ...token,
                    ...metrics,
                    price: token.price || marketInfo.current_price,
                    marketCap: token.marketCap || marketInfo.market_cap,
                    volume24h: token.volume24h || marketInfo.total_volume
                };
            }
            return token;
        });
        res.json(enrichedAltcoins);
    }
    catch (error) {
        console.error('Error fetching altcoins:', error);
        res.status(500).json({ error: 'Failed to fetch altcoins' });
    }
});
// Get a specific altcoin by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const altcoin = await prisma.token.findUnique({
            where: { id }
        });
        if (!altcoin) {
            return res.status(404).json({ error: 'Altcoin not found' });
        }
        res.json(altcoin);
    }
    catch (error) {
        console.error('Error fetching altcoin:', error);
        res.status(500).json({ error: 'Failed to fetch altcoin' });
    }
});
// Create a new altcoin
router.post('/', async (req, res) => {
    try {
        const { name, symbol, marketCap, volume24h, price } = req.body;
        const newAltcoin = await prisma.token.create({
            data: {
                name,
                symbol,
                category: 'altcoin',
                marketCap,
                volume24h,
                price
            }
        });
        res.status(201).json(newAltcoin);
    }
    catch (error) {
        console.error('Error creating altcoin:', error);
        res.status(500).json({ error: 'Failed to create altcoin' });
    }
});
// Update an altcoin
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, symbol, marketCap, volume24h, price } = req.body;
        const updatedAltcoin = await prisma.token.update({
            where: { id },
            data: {
                name,
                symbol,
                marketCap,
                volume24h,
                price
            }
        });
        res.json(updatedAltcoin);
    }
    catch (error) {
        console.error('Error updating altcoin:', error);
        res.status(500).json({ error: 'Failed to update altcoin' });
    }
});
// Delete an altcoin
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.token.delete({
            where: { id }
        });
        res.status(204).send();
    }
    catch (error) {
        console.error('Error deleting altcoin:', error);
        res.status(500).json({ error: 'Failed to delete altcoin' });
    }
});
exports.default = router;
