/**
 * Alert Routes
 * 
 * CRUD operations for price and event alerts.
 */

import express from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest, requireAuth, syncUser, requireFeature, getTierLimits } from '../middleware/auth';
import { logger } from '../services/logger';
import { z } from 'zod';

const router = express.Router();
const prisma = new PrismaClient();

// Validation schemas
const createAlertSchema = z.object({
    tokenId: z.string().uuid(),
    alertType: z.enum(['price_above', 'price_below', 'volume_spike', 'whale_move', 'new_listing']),
    threshold: z.number().positive(),
    channels: z.array(z.enum(['email', 'telegram', 'discord', 'push'])).min(1),
});

const updateAlertSchema = z.object({
    threshold: z.number().positive().optional(),
    channels: z.array(z.enum(['email', 'telegram', 'discord', 'push'])).min(1).optional(),
    isActive: z.boolean().optional(),
});

// All alert routes require authentication and alerts feature
router.use(requireAuth);
router.use(syncUser);
router.use(requireFeature('alerts'));

/**
 * GET /api/alerts - List user's alerts
 */
router.get('/', async (req: AuthenticatedRequest, res) => {
    try {
        const { active, tokenId } = req.query;

        const where: any = { userId: req.user!.id };
        if (active === 'true') where.isActive = true;
        if (active === 'false') where.isActive = false;
        if (tokenId) where.tokenId = tokenId as string;

        const alerts = await prisma.alert.findMany({
            where,
            include: {
                token: {
                    select: {
                        id: true,
                        name: true,
                        symbol: true,
                        chain: true,
                        price: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        const tierLimits = getTierLimits(req.user!.tier);

        res.json({
            alerts,
            count: alerts.length,
            limits: {
                max: tierLimits.maxAlerts,
                used: req.user!.alertCount,
                remaining: tierLimits.maxAlerts === -1 ? 'unlimited' : tierLimits.maxAlerts - req.user!.alertCount,
            },
        });
    } catch (error: any) {
        logger.error(`Error fetching alerts: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch alerts' });
    }
});

/**
 * POST /api/alerts - Create new alert
 */
router.post('/', async (req: AuthenticatedRequest, res) => {
    try {
        const validation = createAlertSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid request', details: validation.error.errors });
        }

        const { tokenId, alertType, threshold, channels } = validation.data;
        const tierLimits = getTierLimits(req.user!.tier);

        // Check tier limit
        if (tierLimits.maxAlerts !== -1 && req.user!.alertCount >= tierLimits.maxAlerts) {
            return res.status(403).json({
                error: 'Alert limit reached',
                message: `Your ${req.user!.tier} plan allows up to ${tierLimits.maxAlerts} alerts`,
                limit: tierLimits.maxAlerts,
            });
        }

        // Verify token exists
        const token = await prisma.token.findUnique({ where: { id: tokenId } });
        if (!token) {
            return res.status(404).json({ error: 'Token not found' });
        }

        // Check if Telegram is required but not connected
        if (channels.includes('telegram')) {
            const user = await prisma.user.findUnique({
                where: { id: req.user!.id },
                select: { telegramVerified: true },
            });
            if (!user?.telegramVerified) {
                return res.status(400).json({
                    error: 'Telegram not connected',
                    message: 'Please connect your Telegram account in settings before creating Telegram alerts',
                });
            }
        }

        // Create alert
        const alert = await prisma.alert.create({
            data: {
                userId: req.user!.id,
                tokenId,
                alertType,
                threshold,
                channels,
            },
            include: {
                token: {
                    select: { id: true, name: true, symbol: true, price: true },
                },
            },
        });

        // Update user alert count
        await prisma.user.update({
            where: { id: req.user!.id },
            data: { alertCount: { increment: 1 } },
        });

        logger.info(`Created alert: ${alert.id} for user ${req.user!.id}`);

        res.status(201).json({
            message: 'Alert created',
            alert,
        });
    } catch (error: any) {
        logger.error(`Error creating alert: ${error.message}`);
        res.status(500).json({ error: 'Failed to create alert' });
    }
});

/**
 * PATCH /api/alerts/:id - Update alert
 */
router.patch('/:id', async (req: AuthenticatedRequest, res) => {
    try {
        const { id } = req.params;
        const validation = updateAlertSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid request', details: validation.error.errors });
        }

        // Verify ownership
        const existing = await prisma.alert.findFirst({
            where: { id, userId: req.user!.id },
        });
        if (!existing) {
            return res.status(404).json({ error: 'Alert not found' });
        }

        const alert = await prisma.alert.update({
            where: { id },
            data: validation.data,
            include: {
                token: {
                    select: { id: true, name: true, symbol: true, price: true },
                },
            },
        });

        res.json({ message: 'Alert updated', alert });
    } catch (error: any) {
        logger.error(`Error updating alert: ${error.message}`);
        res.status(500).json({ error: 'Failed to update alert' });
    }
});

/**
 * DELETE /api/alerts/:id - Delete alert
 */
router.delete('/:id', async (req: AuthenticatedRequest, res) => {
    try {
        const { id } = req.params;

        // Verify ownership
        const existing = await prisma.alert.findFirst({
            where: { id, userId: req.user!.id },
        });
        if (!existing) {
            return res.status(404).json({ error: 'Alert not found' });
        }

        await prisma.alert.delete({ where: { id } });

        // Update user alert count
        await prisma.user.update({
            where: { id: req.user!.id },
            data: { alertCount: { decrement: 1 } },
        });

        res.json({ message: 'Alert deleted' });
    } catch (error: any) {
        logger.error(`Error deleting alert: ${error.message}`);
        res.status(500).json({ error: 'Failed to delete alert' });
    }
});

export default router;
