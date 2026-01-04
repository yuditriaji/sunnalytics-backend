import cron from 'node-cron';
import { logger } from './logger';
import {
    syncExchangeListedTokens,
    populateContractAddresses,
    populateOnChainAnalytics
} from './alternativeDataService';

/**
 * Data refresh scheduler
 * Keeps token data up-to-date automatically
 */

let isRunning = {
    exchangeTokens: false,
    contractAddresses: false,
    onChainAnalytics: false
};

/**
 * Refresh exchange-listed tokens with market data
 * Runs every 15 minutes
 */
async function refreshExchangeTokensJob() {
    if (isRunning.exchangeTokens) {
        logger.info('⏭️ Skipping exchange tokens job - already running');
        return;
    }

    isRunning.exchangeTokens = true;
    try {
        logger.info('🔄 [CRON] Starting exchange tokens refresh...');
        const result = await syncExchangeListedTokens(1);
        logger.info(`✅ [CRON] Exchange tokens refreshed: ${result.success} updated, ${result.errors.length} errors`);
    } catch (error: any) {
        logger.error(`❌ [CRON] Exchange tokens refresh failed: ${error.message}`);
    } finally {
        isRunning.exchangeTokens = false;
    }
}

/**
 * Refresh contract addresses
 * Runs every 6 hours (contract addresses don't change often)
 */
async function refreshContractAddressesJob() {
    if (isRunning.contractAddresses) {
        logger.info('⏭️ Skipping contract addresses job - already running');
        return;
    }

    isRunning.contractAddresses = true;
    try {
        logger.info('🔄 [CRON] Starting contract addresses refresh...');
        const result = await populateContractAddresses();
        logger.info(`✅ [CRON] Contract addresses refreshed: ${result.success} updated, ${result.errors.length} errors`);
    } catch (error: any) {
        logger.error(`❌ [CRON] Contract addresses refresh failed: ${error.message}`);
    } finally {
        isRunning.contractAddresses = false;
    }
}

/**
 * Refresh on-chain analytics
 * Runs every hour
 */
async function refreshOnChainAnalyticsJob() {
    if (isRunning.onChainAnalytics) {
        logger.info('⏭️ Skipping on-chain analytics job - already running');
        return;
    }

    isRunning.onChainAnalytics = true;
    try {
        logger.info('🔄 [CRON] Starting on-chain analytics refresh...');
        const result = await populateOnChainAnalytics();
        logger.info(`✅ [CRON] On-chain analytics refreshed: ${result.success} updated, ${result.errors.length} errors`);
    } catch (error: any) {
        logger.error(`❌ [CRON] On-chain analytics refresh failed: ${error.message}`);
    } finally {
        isRunning.onChainAnalytics = false;
    }
}

/**
 * Initialize all scheduled jobs
 */
export function initScheduler() {
    logger.info('📅 Initializing data refresh scheduler...');

    // Refresh exchange tokens every 15 minutes
    // Pattern: minute hour day-of-month month day-of-week
    cron.schedule('*/15 * * * *', refreshExchangeTokensJob, {
        timezone: 'UTC'
    });
    logger.info('   ⏰ Exchange tokens: every 15 minutes');

    // Refresh contract addresses every 6 hours
    cron.schedule('0 */6 * * *', refreshContractAddressesJob, {
        timezone: 'UTC'
    });
    logger.info('   ⏰ Contract addresses: every 6 hours');

    // Refresh on-chain analytics every hour
    cron.schedule('30 * * * *', refreshOnChainAnalyticsJob, {
        timezone: 'UTC'
    });
    logger.info('   ⏰ On-chain analytics: every hour (at :30)');

    logger.info('✅ Scheduler initialized successfully');
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus() {
    return {
        jobs: {
            exchangeTokens: {
                schedule: 'every 15 minutes',
                isRunning: isRunning.exchangeTokens
            },
            contractAddresses: {
                schedule: 'every 6 hours',
                isRunning: isRunning.contractAddresses
            },
            onChainAnalytics: {
                schedule: 'every hour at :30',
                isRunning: isRunning.onChainAnalytics
            }
        }
    };
}

export default {
    initScheduler,
    getSchedulerStatus
};
