/**
 * User Routes
 * 
 * CRUD operations for user data, watchlist, and preferences.
 */

import express from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest, requireAuth, syncUser, getTierLimits } from '../middleware/auth';
import { logger } from '../services/logger';

const router = express.Router();
const prisma = new PrismaClient() as any;

// All user routes require authentication
router.use(requireAuth);
router.use(syncUser);

/**
 * GET /api/users/me - Get current user profile
 */
router.get('/me', async (req: AuthenticatedRequest, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            include: {
                alerts: {
                    where: { isActive: true },
                    take: 10,
                    orderBy: { createdAt: 'desc' },
                },
            },
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const tierLimits = getTierLimits(user.tier);

        res.json({
            id: user.id,
            email: user.email,
            name: user.name,
            avatarUrl: user.avatarUrl,
            tier: user.tier,
            subscription: {
                tier: user.tier,
                endsAt: user.subscriptionEnd,
                limits: tierLimits,
            },
            usage: {
                alerts: user.alertCount,
                watchlist: user.watchlistCount,
                apiCallsToday: user.apiCallsToday,
            },
            watchlist: user.watchlist,
            preferences: user.preferences,
            telegram: {
                connected: user.telegramVerified,
                chatId: user.telegramChatId ? '***' : null,
            },
            alertsPreview: user.alerts,
            createdAt: user.createdAt,
        });
    } catch (error: any) {
        logger.error(`Error fetching user: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

/**
 * PATCH /api/users/me - Update user profile
 */
router.patch('/me', async (req: AuthenticatedRequest, res) => {
    try {
        const { name, preferences } = req.body;

        const user = await prisma.user.update({
            where: { id: req.user!.id },
            data: {
                ...(name !== undefined && { name }),
                ...(preferences !== undefined && { preferences }),
            },
        });

        res.json({
            id: user.id,
            name: user.name,
            preferences: user.preferences,
        });
    } catch (error: any) {
        logger.error(`Error updating user: ${error.message}`);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

/**
 * GET /api/users/me/watchlist - Get user's watchlist with token data
 */
router.get('/me/watchlist', async (req: AuthenticatedRequest, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { watchlist: true },
        });

        if (!user || user.watchlist.length === 0) {
            return res.json({ tokens: [], count: 0 });
        }

        // Fetch token details for watchlist
        const tokens = await prisma.token.findMany({
            where: { id: { in: user.watchlist } },
            select: {
                id: true,
                name: true,
                symbol: true,
                price: true,
                priceChange24h: true,
                marketCap: true,
                volume24h: true,
                liquidityScore: true,
                pumpDumpRiskScore: true,
            },
        });

        res.json({
            tokens,
            count: tokens.length,
        });
    } catch (error: any) {
        logger.error(`Error fetching watchlist: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch watchlist' });
    }
});

/**
 * POST /api/users/me/watchlist/:tokenId - Add token to watchlist
 */
router.post('/me/watchlist/:tokenId', async (req: AuthenticatedRequest, res) => {
    try {
        const { tokenId } = req.params;
        const tierLimits = getTierLimits(req.user!.tier);

        // Check tier limit (skip if unlimited)
        if (tierLimits.maxWatchlist !== -1 && req.user!.watchlistCount >= tierLimits.maxWatchlist) {
            return res.status(403).json({
                error: 'Watchlist limit reached',
                message: `Your ${req.user!.tier} plan allows up to ${tierLimits.maxWatchlist} watchlist items`,
                limit: tierLimits.maxWatchlist,
            });
        }

        // Verify token exists
        const token = await prisma.token.findUnique({ where: { id: tokenId } });
        if (!token) {
            return res.status(404).json({ error: 'Token not found' });
        }

        // Add to watchlist
        const user = await prisma.user.update({
            where: { id: req.user!.id },
            data: {
                watchlist: { push: tokenId },
                watchlistCount: { increment: 1 },
            },
            select: { watchlist: true, watchlistCount: true },
        });

        res.json({
            message: 'Token added to watchlist',
            watchlist: user.watchlist,
            count: user.watchlistCount,
        });
    } catch (error: any) {
        logger.error(`Error adding to watchlist: ${error.message}`);
        res.status(500).json({ error: 'Failed to add to watchlist' });
    }
});

/**
 * DELETE /api/users/me/watchlist/:tokenId - Remove token from watchlist
 */
router.delete('/me/watchlist/:tokenId', async (req: AuthenticatedRequest, res) => {
    try {
        const { tokenId } = req.params;

        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { watchlist: true },
        });

        if (!user || !user.watchlist.includes(tokenId)) {
            return res.status(404).json({ error: 'Token not in watchlist' });
        }

        const updatedWatchlist = user.watchlist.filter((id: string) => id !== tokenId);

        await prisma.user.update({
            where: { id: req.user!.id },
            data: {
                watchlist: updatedWatchlist,
                watchlistCount: { decrement: 1 },
            },
        });

        res.json({
            message: 'Token removed from watchlist',
            watchlist: updatedWatchlist,
            count: updatedWatchlist.length,
        });
    } catch (error: any) {
        logger.error(`Error removing from watchlist: ${error.message}`);
        res.status(500).json({ error: 'Failed to remove from watchlist' });
    }
});

export default router;
