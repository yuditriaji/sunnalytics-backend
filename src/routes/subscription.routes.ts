/**
 * Subscription Routes (Stripe Integration)
 * 
 * Handles Stripe checkout, webhooks, and subscription management.
 */

import express from 'express';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { AuthenticatedRequest, requireAuth, syncUser } from '../middleware/auth';
import { logger } from '../services/logger';

const router = express.Router();
const prisma = new PrismaClient();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2024-12-18.acacia',
});

// Price IDs (configure these in your Stripe dashboard)
const PRICE_IDS = {
    pro: process.env.STRIPE_PRICE_PRO || 'price_pro_monthly',
    whale: process.env.STRIPE_PRICE_WHALE || 'price_whale_monthly',
};

/**
 * POST /api/subscription/create-checkout - Create Stripe checkout session
 */
router.post('/create-checkout', requireAuth, syncUser, async (req: AuthenticatedRequest, res) => {
    try {
        const { tier } = req.body;

        if (!tier || !['pro', 'whale'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid tier. Must be "pro" or "whale"' });
        }

        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Create or get Stripe customer
        let customerId = user.stripeCustomerId;
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: user.email,
                name: user.name || undefined,
                metadata: { userId: user.id },
            });
            customerId = customer.id;

            await prisma.user.update({
                where: { id: user.id },
                data: { stripeCustomerId: customerId },
            });
        }

        // Create checkout session
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [
                {
                    price: PRICE_IDS[tier as keyof typeof PRICE_IDS],
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?success=true`,
            cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?canceled=true`,
            metadata: {
                userId: user.id,
                tier,
            },
        });

        res.json({ sessionId: session.id, url: session.url });
    } catch (error: any) {
        logger.error(`Error creating checkout: ${error.message}`);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

/**
 * POST /api/subscription/create-portal - Create Stripe billing portal
 */
router.post('/create-portal', requireAuth, syncUser, async (req: AuthenticatedRequest, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { stripeCustomerId: true },
        });

        if (!user?.stripeCustomerId) {
            return res.status(400).json({ error: 'No subscription found' });
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: user.stripeCustomerId,
            return_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings`,
        });

        res.json({ url: session.url });
    } catch (error: any) {
        logger.error(`Error creating portal: ${error.message}`);
        res.status(500).json({ error: 'Failed to create billing portal' });
    }
});

/**
 * POST /api/subscription/webhook - Stripe webhook handler
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
        logger.error('Stripe webhook secret not configured');
        return res.status(500).json({ error: 'Webhook not configured' });
    }

    let event: Stripe.Event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err: any) {
        logger.error(`Webhook signature verification failed: ${err.message}`);
        return res.status(400).json({ error: 'Webhook signature verification failed' });
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object as Stripe.Checkout.Session;
                const userId = session.metadata?.userId;
                const tier = session.metadata?.tier;

                if (userId && tier) {
                    await prisma.user.update({
                        where: { id: userId },
                        data: {
                            tier,
                            subscriptionId: session.subscription as string,
                        },
                    });
                    logger.info(`User ${userId} upgraded to ${tier}`);
                }
                break;
            }

            case 'customer.subscription.updated': {
                const subscription = event.data.object as Stripe.Subscription;
                const customer = await stripe.customers.retrieve(subscription.customer as string);

                if ('metadata' in customer && customer.metadata?.userId) {
                    const periodEnd = new Date(subscription.current_period_end * 1000);

                    await prisma.user.update({
                        where: { id: customer.metadata.userId },
                        data: {
                            subscriptionEnd: periodEnd,
                        },
                    });
                }
                break;
            }

            case 'customer.subscription.deleted': {
                const subscription = event.data.object as Stripe.Subscription;
                const customer = await stripe.customers.retrieve(subscription.customer as string);

                if ('metadata' in customer && customer.metadata?.userId) {
                    await prisma.user.update({
                        where: { id: customer.metadata.userId },
                        data: {
                            tier: 'free',
                            subscriptionId: null,
                            subscriptionEnd: null,
                        },
                    });
                    logger.info(`User ${customer.metadata.userId} downgraded to free`);
                }
                break;
            }

            default:
                logger.info(`Unhandled event type: ${event.type}`);
        }

        res.json({ received: true });
    } catch (error: any) {
        logger.error(`Error processing webhook: ${error.message}`);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

/**
 * GET /api/subscription/status - Get current subscription status
 */
router.get('/status', requireAuth, syncUser, async (req: AuthenticatedRequest, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: {
                tier: true,
                subscriptionId: true,
                subscriptionEnd: true,
                stripeCustomerId: true,
            },
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        let stripeSubscription = null;
        if (user.subscriptionId) {
            try {
                stripeSubscription = await stripe.subscriptions.retrieve(user.subscriptionId);
            } catch (e) {
                // Subscription might not exist anymore
            }
        }

        res.json({
            tier: user.tier,
            isActive: user.tier !== 'free',
            subscriptionEnd: user.subscriptionEnd,
            cancelAtPeriodEnd: stripeSubscription?.cancel_at_period_end || false,
        });
    } catch (error: any) {
        logger.error(`Error fetching subscription: ${error.message}`);
        res.status(500).json({ error: 'Failed to fetch subscription status' });
    }
});

export default router;
