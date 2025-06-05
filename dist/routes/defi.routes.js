"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const client_1 = require("@prisma/client");
const router = express_1.default.Router();
const prisma = new client_1.PrismaClient();
// Get all DeFi tokens
router.get('/', async (req, res) => {
    try {
        const defiTokens = await prisma.token.findMany({
            where: {
                category: 'defi'
            }
        });
        res.json(defiTokens);
    }
    catch (error) {
        console.error('Error fetching DeFi tokens:', error);
        res.status(500).json({ error: 'Failed to fetch DeFi tokens' });
    }
});
// Get a specific DeFi token by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const defiToken = await prisma.token.findUnique({
            where: { id }
        });
        if (!defiToken) {
            return res.status(404).json({ error: 'DeFi token not found' });
        }
        res.json(defiToken);
    }
    catch (error) {
        console.error('Error fetching DeFi token:', error);
        res.status(500).json({ error: 'Failed to fetch DeFi token' });
    }
});
// Create a new DeFi token
router.post('/', async (req, res) => {
    try {
        const { name, symbol, marketCap, volume24h, price } = req.body;
        const newDefiToken = await prisma.token.create({
            data: {
                name,
                symbol,
                category: 'defi',
                marketCap,
                volume24h,
                price
            }
        });
        res.status(201).json(newDefiToken);
    }
    catch (error) {
        console.error('Error creating DeFi token:', error);
        res.status(500).json({ error: 'Failed to create DeFi token' });
    }
});
// Update a DeFi token
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, symbol, marketCap, volume24h, price } = req.body;
        const updatedDefiToken = await prisma.token.update({
            where: { id },
            data: {
                name,
                symbol,
                marketCap,
                volume24h,
                price
            }
        });
        res.json(updatedDefiToken);
    }
    catch (error) {
        console.error('Error updating DeFi token:', error);
        res.status(500).json({ error: 'Failed to update DeFi token' });
    }
});
// Delete a DeFi token
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.token.delete({
            where: { id }
        });
        res.status(204).send();
    }
    catch (error) {
        console.error('Error deleting DeFi token:', error);
        res.status(500).json({ error: 'Failed to delete DeFi token' });
    }
});
exports.default = router;
