import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireTier } from '../middleware/auth';
import { connectExchange, syncExchange, SUPPORTED_EXCHANGES, ExchangeType } from '../services/cexSync';
import { logger } from '../services/logger';

const router = Router();
const prisma = new PrismaClient() as any;

// Tier-based exchange limits
const EXCHANGE_LIMITS = {
    free: 0, // Free users cannot connect exchanges
    pro: 3,
    whale: 10,
};

// Validation schema
const ConnectExchangeSchema = z.object({
    exchange: z.enum(SUPPORTED_EXCHANGES),
    apiKey: z.string().min(10),
    apiSecret: z.string().min(10),
    passphrase: z.string().optional(), // Required for OKX
    label: z.string().max(50).optional(),
});

// =============================================================================
// GET /api/exchanges - List user's connected exchanges
// =============================================================================
router.get('/', requireAuth, requireTier('pro'), async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;

        const connections = await prisma.exchangeConnection.findMany({
            where: { userId },
            select: {
                id: true,
                exchange: true,
                label: true,
                syncStatus: true,
                lastSynced: true,
                syncError: true,
                createdAt: true,
                holdings: {
                    orderBy: { valueUsd: 'desc' },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        // Calculate total value
        const totalValueUsd = connections.reduce((total: number, conn: any) => {
            const connValue = conn.holdings.reduce(
                (sum: number, h: any) => sum + (parseFloat(h.valueUsd) || 0),
                0
            );
            return total + connValue;
        }, 0);

        res.json({
            connections,
            summary: {
                totalConnections: connections.length,
                totalValueUsd,
            },
        });
    } catch (error: any) {
        logger.error(`Failed to list exchanges: ${error.message}`);
        res.status(500).json({ error: 'Failed to list exchanges' });
    }
});

// =============================================================================
// POST /api/exchanges - Connect a new exchange
// =============================================================================
router.post('/', requireAuth, requireTier('pro'), async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        const user = (req as any).user;

        // Validate input
        const validation = ConnectExchangeSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid exchange data', details: validation.error.errors });
        }

        const { exchange, apiKey, apiSecret, passphrase, label } = validation.data;

        // OKX requires passphrase
        if (exchange === 'okx' && !passphrase) {
            return res.status(400).json({ error: 'OKX requires a passphrase' });
        }

        // Check tier limits
        const connectionCount = await prisma.exchangeConnection.count({
            where: { userId },
        });

        const limit = EXCHANGE_LIMITS[user.tier as keyof typeof EXCHANGE_LIMITS] || 0;
        if (connectionCount >= limit) {
            return res.status(403).json({
                error: 'Exchange limit reached',
                limit,
                current: connectionCount,
                upgrade: 'Upgrade to Whale for more exchanges',
            });
        }

        // Check if this exchange is already connected
        const existing = await prisma.exchangeConnection.findFirst({
            where: { userId, exchange },
        });

        if (existing) {
            return res.status(409).json({ error: `${exchange} already connected` });
        }

        // Connect and sync
        const connection = await connectExchange(
            userId,
            exchange as ExchangeType,
            apiKey,
            apiSecret,
            passphrase,
            label
        );

        res.status(201).json({
            connection: {
                id: connection.id,
                exchange: connection.exchange,
                label: connection.label,
                syncStatus: connection.syncStatus,
            },
            message: 'Exchange connected. Syncing balances...',
        });
    } catch (error: any) {
        logger.error(`Failed to connect exchange: ${error.message}`);

        // Check for common API errors
        if (error.message.includes('Invalid API')) {
            return res.status(401).json({ error: 'Invalid API credentials' });
        }

        res.status(500).json({ error: error.message || 'Failed to connect exchange' });
    }
});

// =============================================================================
// POST /api/exchanges/:id/sync - Sync exchange holdings
// =============================================================================
router.post('/:id/sync', requireAuth, requireTier('pro'), async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        const { id } = req.params;

        const connection = await prisma.exchangeConnection.findFirst({
            where: { id, userId },
        });

        if (!connection) {
            return res.status(404).json({ error: 'Exchange connection not found' });
        }

        // Cooldown check
        if (connection.lastSynced) {
            const since = Date.now() - new Date(connection.lastSynced).getTime();
            const cooldown = 60000; // 1 min
            if (since < cooldown) {
                return res.status(429).json({
                    error: 'Sync cooldown',
                    retryAfter: Math.ceil((cooldown - since) / 1000),
                });
            }
        }

        await syncExchange(id);

        const updated = await prisma.exchangeConnection.findUnique({
            where: { id },
            include: { holdings: true },
        });

        res.json({ connection: updated, message: 'Exchange synced' });
    } catch (error: any) {
        logger.error(`Failed to sync exchange: ${error.message}`);
        res.status(500).json({ error: 'Failed to sync exchange' });
    }
});

// =============================================================================
// DELETE /api/exchanges/:id - Disconnect an exchange
// =============================================================================
router.delete('/:id', requireAuth, requireTier('pro'), async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        const { id } = req.params;

        const connection = await prisma.exchangeConnection.findFirst({
            where: { id, userId },
        });

        if (!connection) {
            return res.status(404).json({ error: 'Exchange connection not found' });
        }

        // Delete connection (cascades to holdings)
        await prisma.exchangeConnection.delete({
            where: { id },
        });

        res.json({ message: 'Exchange disconnected' });
    } catch (error: any) {
        logger.error(`Failed to disconnect exchange: ${error.message}`);
        res.status(500).json({ error: 'Failed to disconnect exchange' });
    }
});

// =============================================================================
// GET /api/exchanges/:id/holdings - Get exchange holdings
// =============================================================================
router.get('/:id/holdings', requireAuth, requireTier('pro'), async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        const { id } = req.params;

        const connection = await prisma.exchangeConnection.findFirst({
            where: { id, userId },
            include: {
                holdings: {
                    orderBy: { valueUsd: 'desc' },
                },
            },
        });

        if (!connection) {
            return res.status(404).json({ error: 'Exchange connection not found' });
        }

        const totalValue = connection.holdings.reduce(
            (sum: number, h: any) => sum + (parseFloat(h.valueUsd) || 0),
            0
        );

        res.json({
            exchange: {
                id: connection.id,
                exchange: connection.exchange,
                label: connection.label,
                lastSynced: connection.lastSynced,
                syncStatus: connection.syncStatus,
            },
            holdings: connection.holdings,
            summary: {
                totalAssets: connection.holdings.length,
                totalValueUsd: totalValue,
            },
        });
    } catch (error: any) {
        logger.error(`Failed to get holdings: ${error.message}`);
        res.status(500).json({ error: 'Failed to get holdings' });
    }
});

export default router;
