/**
 * Clerk Authentication Middleware
 * 
 * Provides authentication for Express routes using Clerk.
 * Also includes tier-based access control.
 */

import { Request, Response, NextFunction } from 'express';
import { clerkClient, ClerkExpressRequireAuth, ClerkExpressWithAuth, WithAuthProp } from '@clerk/clerk-sdk-node';
import { PrismaClient } from '@prisma/client';
import { logger } from '../services/logger';

const prisma = new PrismaClient();

// Extend Express Request to include auth
export interface AuthenticatedRequest extends Request {
    auth?: {
        userId: string;
        sessionId?: string;
    };
    user?: {
        id: string;
        email: string;
        tier: string;
        stripeCustomerId?: string | null;
        alertCount: number;
        watchlistCount: number;
        apiCallsToday: number;
    };
}

// Tier limits configuration
export const TIER_LIMITS = {
    free: {
        maxAlerts: 3,
        maxWatchlist: 10,
        maxApiCallsPerDay: 100,
        dataRefreshMinutes: 60,
        features: ['basic_analytics', 'watchlist'],
    },
    pro: {
        maxAlerts: 50,
        maxWatchlist: 100,
        maxApiCallsPerDay: 5000,
        dataRefreshMinutes: 5,
        features: ['basic_analytics', 'watchlist', 'alerts', 'advanced_analytics', 'export'],
    },
    whale: {
        maxAlerts: -1, // Unlimited
        maxWatchlist: -1,
        maxApiCallsPerDay: -1,
        dataRefreshMinutes: 1,
        features: ['basic_analytics', 'watchlist', 'alerts', 'advanced_analytics', 'export', 'api_access', 'realtime'],
    },
} as const;

export type TierName = keyof typeof TIER_LIMITS;

/**
 * Require authentication - blocks unauthorized requests
 */
export const requireAuth = ClerkExpressRequireAuth();

/**
 * Optional authentication - attaches user if present, continues if not
 */
export const optionalAuth = ClerkExpressWithAuth();

/**
 * Sync user from Clerk to database and attach to request
 */
export async function syncUser(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
        if (!req.auth?.userId) {
            return next();
        }

        const clerkUserId = req.auth.userId;

        // Try to find existing user
        let user = await prisma.user.findUnique({
            where: { id: clerkUserId },
        });

        // If user doesn't exist, create from Clerk data
        if (!user) {
            const clerkUser = await clerkClient.users.getUser(clerkUserId);

            user = await prisma.user.create({
                data: {
                    id: clerkUserId,
                    email: clerkUser.emailAddresses[0]?.emailAddress || '',
                    name: `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim() || null,
                    avatarUrl: clerkUser.imageUrl || null,
                    tier: 'free',
                },
            });

            logger.info(`Created new user: ${user.id} (${user.email})`);
        }

        // Attach user to request
        req.user = {
            id: user.id,
            email: user.email,
            tier: user.tier,
            stripeCustomerId: user.stripeCustomerId,
            alertCount: user.alertCount,
            watchlistCount: user.watchlistCount,
            apiCallsToday: user.apiCallsToday,
        };

        // Check and reset daily API counter
        const now = new Date();
        const lastReset = new Date(user.lastApiReset);
        if (now.getDate() !== lastReset.getDate()) {
            await prisma.user.update({
                where: { id: user.id },
                data: { apiCallsToday: 0, lastApiReset: now },
            });
            req.user.apiCallsToday = 0;
        }

        next();
    } catch (error: any) {
        logger.error(`Error syncing user: ${error.message}`);
        next(error);
    }
}

/**
 * Require specific tier or higher
 */
export function requireTier(minTier: TierName) {
    const tierOrder: TierName[] = ['free', 'pro', 'whale'];

    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const userTierIndex = tierOrder.indexOf(req.user.tier as TierName);
        const requiredTierIndex = tierOrder.indexOf(minTier);

        if (userTierIndex < requiredTierIndex) {
            return res.status(403).json({
                error: 'Upgrade required',
                message: `This feature requires ${minTier} tier or higher`,
                currentTier: req.user.tier,
                requiredTier: minTier,
            });
        }

        next();
    };
}

/**
 * Check feature access
 */
export function requireFeature(feature: string) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const tierName = req.user.tier as TierName;
        const tierConfig = TIER_LIMITS[tierName] || TIER_LIMITS.free;

        if (!tierConfig.features.includes(feature)) {
            return res.status(403).json({
                error: 'Feature not available',
                message: `Your current plan does not include access to ${feature}`,
                currentTier: req.user.tier,
            });
        }

        next();
    };
}

/**
 * Rate limit based on tier
 */
export async function trackApiUsage(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.user) {
        return next();
    }

    const tierName = req.user.tier as TierName;
    const tierConfig = TIER_LIMITS[tierName] || TIER_LIMITS.free;

    // Unlimited for whale tier
    if (tierConfig.maxApiCallsPerDay === -1) {
        return next();
    }

    if (req.user.apiCallsToday >= tierConfig.maxApiCallsPerDay) {
        return res.status(429).json({
            error: 'API limit exceeded',
            message: `You have exceeded your daily API limit of ${tierConfig.maxApiCallsPerDay} calls`,
            currentTier: req.user.tier,
            limit: tierConfig.maxApiCallsPerDay,
            used: req.user.apiCallsToday,
        });
    }

    // Increment counter
    await prisma.user.update({
        where: { id: req.user.id },
        data: { apiCallsToday: { increment: 1 } },
    });

    next();
}

/**
 * Get user's tier limits
 */
export function getTierLimits(tier: string): typeof TIER_LIMITS.free {
    return TIER_LIMITS[tier as TierName] || TIER_LIMITS.free;
}
