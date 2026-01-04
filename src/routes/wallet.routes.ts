import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireTier } from '../middleware/auth';
import { isValidSolanaAddress, syncWallet as syncSolanaWallet, syncUserWallets } from '../services/solanaSync';
import { isValidEvmAddress, syncEvmWallet } from '../services/evmSync';
import { logger } from '../services/logger';

const router = Router();
const prisma = new PrismaClient() as any;

// Tier-based wallet limits
const WALLET_LIMITS = {
    free: 2,
    pro: 10,
    whale: 100, // Essentially unlimited
};

// Validation schemas
const AddWalletSchema = z.object({
    address: z.string().min(32).max(66), // Extended for EVM addresses (0x + 40 hex)
    chain: z.enum(['solana', 'ethereum', 'bsc', 'base', 'arbitrum']).default('solana'),
    label: z.string().max(50).optional(),
});

// EVM chains list
const EVM_CHAINS = ['ethereum', 'bsc', 'base', 'arbitrum'];

// Smart sync routing based on chain
async function syncWallet(walletId: string, chain: string): Promise<void> {
    if (EVM_CHAINS.includes(chain)) {
        await syncEvmWallet(walletId);
    } else {
        await syncSolanaWallet(walletId);
    }
}

// Validate address based on chain
function isValidAddress(address: string, chain: string): boolean {
    if (EVM_CHAINS.includes(chain)) {
        return isValidEvmAddress(address);
    }
    return isValidSolanaAddress(address);
}

// =============================================================================
// GET /api/wallets - List user's connected wallets
// =============================================================================
router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;

        const wallets = await prisma.walletConnection.findMany({
            where: { userId },
            include: {
                holdings: {
                    orderBy: { valueUsd: 'desc' },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        // Calculate total portfolio value
        const portfolioValue = wallets.reduce((total: number, wallet: any) => {
            const walletValue = wallet.holdings.reduce(
                (sum: number, h: any) => sum + (parseFloat(h.valueUsd) || 0),
                0
            );
            return total + walletValue;
        }, 0);

        res.json({
            wallets,
            summary: {
                totalWallets: wallets.length,
                portfolioValueUsd: portfolioValue,
            },
        });
    } catch (error: any) {
        logger.error(`Failed to list wallets: ${error.message}`);
        res.status(500).json({ error: 'Failed to list wallets' });
    }
});

// =============================================================================
// POST /api/wallets - Add a new wallet connection
// =============================================================================
router.post('/', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        const user = (req as any).user;

        // Validate input
        const validation = AddWalletSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid wallet data', details: validation.error.errors });
        }

        const { address, chain, label } = validation.data;

        // Validate address format based on chain
        if (!isValidAddress(address, chain)) {
            return res.status(400).json({ error: `Invalid ${chain} address format` });
        }

        // Check tier limits
        const walletCount = await prisma.walletConnection.count({
            where: { userId },
        });

        const limit = WALLET_LIMITS[user.tier as keyof typeof WALLET_LIMITS] || WALLET_LIMITS.free;
        if (walletCount >= limit) {
            return res.status(403).json({
                error: 'Wallet limit reached',
                limit,
                current: walletCount,
                upgrade: user.tier === 'free' ? 'Upgrade to Pro for up to 10 wallets' : undefined,
            });
        }

        // Check if wallet already exists for this user
        const existing = await prisma.walletConnection.findFirst({
            where: { userId, chain, address },
        });

        if (existing) {
            return res.status(409).json({ error: 'Wallet already connected' });
        }

        // Create wallet connection
        const wallet = await prisma.walletConnection.create({
            data: {
                userId,
                chain,
                address,
                label,
                syncStatus: 'pending',
            },
        });

        // Trigger initial sync (async) with smart routing
        syncWallet(wallet.id, chain).catch((err) => {
            logger.error(`Initial sync failed for wallet ${wallet.id}: ${err.message}`);
        });

        res.status(201).json({
            wallet,
            message: 'Wallet connected. Syncing holdings...',
        });
    } catch (error: any) {
        logger.error(`Failed to add wallet: ${error.message}`);
        res.status(500).json({ error: 'Failed to add wallet' });
    }
});

// =============================================================================
// POST /api/wallets/:id/sync - Manually trigger wallet sync
// =============================================================================
router.post('/:id/sync', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        const { id } = req.params;

        const wallet = await prisma.walletConnection.findFirst({
            where: { id, userId },
        });

        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }

        // Check sync cooldown (prevent abuse)
        if (wallet.lastSynced) {
            const since = Date.now() - new Date(wallet.lastSynced).getTime();
            const cooldown = 60000; // 1 minute cooldown
            if (since < cooldown) {
                return res.status(429).json({
                    error: 'Sync cooldown',
                    retryAfter: Math.ceil((cooldown - since) / 1000),
                });
            }
        }

        // Trigger sync with smart routing
        await syncWallet(id, wallet.chain);

        // Fetch updated wallet
        const updated = await prisma.walletConnection.findUnique({
            where: { id },
            include: { holdings: true },
        });

        res.json({ wallet: updated, message: 'Wallet synced successfully' });
    } catch (error: any) {
        logger.error(`Failed to sync wallet: ${error.message}`);
        res.status(500).json({ error: 'Failed to sync wallet' });
    }
});

// =============================================================================
// DELETE /api/wallets/:id - Remove a wallet connection
// =============================================================================
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        const { id } = req.params;

        const wallet = await prisma.walletConnection.findFirst({
            where: { id, userId },
        });

        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }

        // Delete wallet (cascades to holdings)
        await prisma.walletConnection.delete({
            where: { id },
        });

        res.json({ message: 'Wallet disconnected' });
    } catch (error: any) {
        logger.error(`Failed to delete wallet: ${error.message}`);
        res.status(500).json({ error: 'Failed to delete wallet' });
    }
});

// =============================================================================
// GET /api/wallets/:id/holdings - Get wallet holdings
// =============================================================================
router.get('/:id/holdings', requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        const { id } = req.params;

        const wallet = await prisma.walletConnection.findFirst({
            where: { id, userId },
            include: {
                holdings: {
                    orderBy: { valueUsd: 'desc' },
                },
            },
        });

        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }

        // Calculate totals
        const totalValue = wallet.holdings.reduce(
            (sum: number, h: any) => sum + (parseFloat(h.valueUsd) || 0),
            0
        );

        res.json({
            wallet: {
                id: wallet.id,
                address: wallet.address,
                chain: wallet.chain,
                label: wallet.label,
                lastSynced: wallet.lastSynced,
                syncStatus: wallet.syncStatus,
            },
            holdings: wallet.holdings,
            summary: {
                totalTokens: wallet.holdings.length,
                totalValueUsd: totalValue,
            },
        });
    } catch (error: any) {
        logger.error(`Failed to get holdings: ${error.message}`);
        res.status(500).json({ error: 'Failed to get holdings' });
    }
});

// =============================================================================
// POST /api/wallets/sync-all - Sync all user wallets (Pro+)
// =============================================================================
router.post('/sync-all', requireAuth, requireTier('pro'), async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;

        // Trigger sync for all wallets (async)
        syncUserWallets(userId).catch((err) => {
            logger.error(`Sync all failed for user ${userId}: ${err.message}`);
        });

        res.json({ message: 'Syncing all wallets...' });
    } catch (error: any) {
        logger.error(`Failed to sync all wallets: ${error.message}`);
        res.status(500).json({ error: 'Failed to sync wallets' });
    }
});

export default router;
