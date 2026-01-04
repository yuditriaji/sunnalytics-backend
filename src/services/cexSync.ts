import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import axios from 'axios';
import { logger } from './logger';

// Cast to any for schema migration compatibility
const prisma = new PrismaClient() as any;

// Encryption key for API secrets (should be 32 bytes for AES-256)
const ENCRYPTION_KEY = process.env.CEX_ENCRYPTION_KEY || 'sunnalytics-default-key-32bytes!';

// Supported exchanges
export const SUPPORTED_EXCHANGES = ['binance', 'bybit', 'okx'] as const;
export type ExchangeType = typeof SUPPORTED_EXCHANGES[number];

// =============================================================================
// Encryption utilities for API secrets
// =============================================================================

function encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText: string): string {
    const [ivHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// =============================================================================
// Exchange API interfaces
// =============================================================================

interface ExchangeBalance {
    asset: string;
    free: number;
    locked: number;
    total: number;
    valueUsd?: number;
}

interface ExchangeAdapter {
    fetchBalances(apiKey: string, apiSecret: string, passphrase?: string): Promise<ExchangeBalance[]>;
}

// =============================================================================
// Binance adapter
// =============================================================================

const binanceAdapter: ExchangeAdapter = {
    async fetchBalances(apiKey: string, apiSecret: string): Promise<ExchangeBalance[]> {
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;

        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');

        try {
            const response = await axios.get('https://api.binance.com/api/v3/account', {
                headers: { 'X-MBX-APIKEY': apiKey },
                params: { timestamp, signature },
                timeout: 15000,
            });

            const balances = (response.data.balances || [])
                .filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
                .map((b: any) => ({
                    asset: b.asset,
                    free: parseFloat(b.free),
                    locked: parseFloat(b.locked),
                    total: parseFloat(b.free) + parseFloat(b.locked),
                }));

            return balances;
        } catch (error: any) {
            logger.error(`Binance API error: ${error.response?.data?.msg || error.message}`);
            throw new Error(error.response?.data?.msg || 'Binance API error');
        }
    },
};

// =============================================================================
// Bybit adapter
// =============================================================================

const bybitAdapter: ExchangeAdapter = {
    async fetchBalances(apiKey: string, apiSecret: string): Promise<ExchangeBalance[]> {
        const timestamp = Date.now();
        const recvWindow = 5000;
        const queryParams = `accountType=UNIFIED`;

        const signPayload = `${timestamp}${apiKey}${recvWindow}${queryParams}`;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(signPayload)
            .digest('hex');

        try {
            const response = await axios.get('https://api.bybit.com/v5/account/wallet-balance', {
                headers: {
                    'X-BAPI-API-KEY': apiKey,
                    'X-BAPI-SIGN': signature,
                    'X-BAPI-TIMESTAMP': timestamp.toString(),
                    'X-BAPI-RECV-WINDOW': recvWindow.toString(),
                },
                params: { accountType: 'UNIFIED' },
                timeout: 15000,
            });

            if (response.data.retCode !== 0) {
                throw new Error(response.data.retMsg);
            }

            const coins = response.data.result?.list?.[0]?.coin || [];
            const balances = coins
                .filter((c: any) => parseFloat(c.walletBalance) > 0)
                .map((c: any) => ({
                    asset: c.coin,
                    free: parseFloat(c.availableToWithdraw) || 0,
                    locked: parseFloat(c.walletBalance) - (parseFloat(c.availableToWithdraw) || 0),
                    total: parseFloat(c.walletBalance),
                    valueUsd: parseFloat(c.usdValue) || undefined,
                }));

            return balances;
        } catch (error: any) {
            logger.error(`Bybit API error: ${error.response?.data?.retMsg || error.message}`);
            throw new Error(error.response?.data?.retMsg || 'Bybit API error');
        }
    },
};

// =============================================================================
// OKX adapter
// =============================================================================

const okxAdapter: ExchangeAdapter = {
    async fetchBalances(apiKey: string, apiSecret: string, passphrase?: string): Promise<ExchangeBalance[]> {
        const timestamp = new Date().toISOString();
        const method = 'GET';
        const requestPath = '/api/v5/account/balance';

        const signPayload = timestamp + method + requestPath;
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(signPayload)
            .digest('base64');

        try {
            const response = await axios.get('https://www.okx.com/api/v5/account/balance', {
                headers: {
                    'OK-ACCESS-KEY': apiKey,
                    'OK-ACCESS-SIGN': signature,
                    'OK-ACCESS-TIMESTAMP': timestamp,
                    'OK-ACCESS-PASSPHRASE': passphrase || '',
                },
                timeout: 15000,
            });

            if (response.data.code !== '0') {
                throw new Error(response.data.msg);
            }

            const details = response.data.data?.[0]?.details || [];
            const balances = details
                .filter((d: any) => parseFloat(d.availBal) > 0 || parseFloat(d.frozenBal) > 0)
                .map((d: any) => ({
                    asset: d.ccy,
                    free: parseFloat(d.availBal) || 0,
                    locked: parseFloat(d.frozenBal) || 0,
                    total: parseFloat(d.availBal) + parseFloat(d.frozenBal),
                }));

            return balances;
        } catch (error: any) {
            logger.error(`OKX API error: ${error.response?.data?.msg || error.message}`);
            throw new Error(error.response?.data?.msg || 'OKX API error');
        }
    },
};

// Exchange adapter map
const adapters: Record<ExchangeType, ExchangeAdapter> = {
    binance: binanceAdapter,
    bybit: bybitAdapter,
    okx: okxAdapter,
};

// =============================================================================
// Fetch prices for CEX assets
// =============================================================================

async function fetchAssetPrices(assets: string[]): Promise<Record<string, number>> {
    const symbolMap: Record<string, string> = {
        BTC: 'bitcoin',
        ETH: 'ethereum',
        USDT: 'tether',
        USDC: 'usd-coin',
        BNB: 'binancecoin',
        SOL: 'solana',
        XRP: 'ripple',
        DOGE: 'dogecoin',
        ADA: 'cardano',
        AVAX: 'avalanche-2',
        DOT: 'polkadot',
        MATIC: 'matic-network',
        LINK: 'chainlink',
        UNI: 'uniswap',
    };

    const ids = assets
        .map((a) => symbolMap[a.toUpperCase()])
        .filter(Boolean)
        .slice(0, 50);

    if (ids.length === 0) return {};

    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: { ids: ids.join(','), vs_currencies: 'usd' },
            timeout: 15000,
        });

        const prices: Record<string, number> = {};
        for (const [asset, id] of Object.entries(symbolMap)) {
            if (response.data[id]) {
                prices[asset] = response.data[id].usd;
            }
        }

        // Stablecoins
        prices['USDT'] = 1;
        prices['USDC'] = 1;
        prices['BUSD'] = 1;
        prices['DAI'] = 1;

        return prices;
    } catch {
        return { USDT: 1, USDC: 1, BUSD: 1, DAI: 1 };
    }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Connect a new exchange account
 */
export async function connectExchange(
    userId: string,
    exchange: ExchangeType,
    apiKey: string,
    apiSecret: string,
    passphrase?: string,
    label?: string
): Promise<any> {
    // Validate exchange
    if (!SUPPORTED_EXCHANGES.includes(exchange)) {
        throw new Error(`Unsupported exchange: ${exchange}`);
    }

    // Test the connection by fetching balances
    const adapter = adapters[exchange];
    await adapter.fetchBalances(apiKey, apiSecret, passphrase);

    // Encrypt the API credentials
    const encryptedKey = encrypt(apiKey);
    const encryptedSecret = encrypt(apiSecret);
    const encryptedPassphrase = passphrase ? encrypt(passphrase) : null;

    // Create connection
    const connection = await prisma.exchangeConnection.create({
        data: {
            userId,
            exchange,
            label,
            encryptedApiKey: encryptedKey,
            encryptedApiSecret: encryptedSecret,
            encryptedPassphrase,
            syncStatus: 'pending',
        },
    });

    // Trigger initial sync
    syncExchange(connection.id).catch((err) => {
        logger.error(`Initial CEX sync failed: ${err.message}`);
    });

    return connection;
}

/**
 * Sync exchange holdings
 */
export async function syncExchange(connectionId: string): Promise<void> {
    const connection = await prisma.exchangeConnection.findUnique({
        where: { id: connectionId },
    });

    if (!connection) {
        throw new Error(`Connection ${connectionId} not found`);
    }

    const exchange = connection.exchange as ExchangeType;
    const adapter = adapters[exchange];

    try {
        // Update status
        await prisma.exchangeConnection.update({
            where: { id: connectionId },
            data: { syncStatus: 'syncing' },
        });

        // Decrypt credentials
        const apiKey = decrypt(connection.encryptedApiKey);
        const apiSecret = decrypt(connection.encryptedApiSecret);
        const passphrase = connection.encryptedPassphrase
            ? decrypt(connection.encryptedPassphrase)
            : undefined;

        // Fetch balances
        const balances = await adapter.fetchBalances(apiKey, apiSecret, passphrase);

        // Fetch prices
        const assets = balances.map((b) => b.asset);
        const prices = await fetchAssetPrices(assets);

        // Upsert holdings
        for (const balance of balances) {
            const price = prices[balance.asset] || balance.valueUsd || null;
            const valueUsd = price ? balance.total * price : null;

            await prisma.exchangeHolding.upsert({
                where: {
                    connectionId_asset: { connectionId, asset: balance.asset },
                },
                update: {
                    free: balance.free,
                    locked: balance.locked,
                    total: balance.total,
                    priceUsd: price,
                    valueUsd,
                    updatedAt: new Date(),
                },
                create: {
                    connectionId,
                    asset: balance.asset,
                    free: balance.free,
                    locked: balance.locked,
                    total: balance.total,
                    priceUsd: price,
                    valueUsd,
                },
            });
        }

        // Remove assets no longer held
        const heldAssets = balances.map((b) => b.asset);
        await prisma.exchangeHolding.deleteMany({
            where: {
                connectionId,
                asset: { notIn: heldAssets },
            },
        });

        // Update status
        await prisma.exchangeConnection.update({
            where: { id: connectionId },
            data: {
                syncStatus: 'success',
                lastSynced: new Date(),
                syncError: null,
            },
        });

        logger.info(`Synced ${exchange} exchange for connection ${connectionId}`);
    } catch (error: any) {
        await prisma.exchangeConnection.update({
            where: { id: connectionId },
            data: {
                syncStatus: 'error',
                syncError: error.message,
            },
        });

        logger.error(`CEX sync failed: ${error.message}`);
        throw error;
    }
}

/**
 * Sync all user's exchange connections
 */
export async function syncUserExchanges(userId: string): Promise<void> {
    const connections = await prisma.exchangeConnection.findMany({
        where: { userId },
    });

    for (const connection of connections) {
        await syncExchange(connection.id).catch((err) => {
            logger.warn(`Failed to sync ${connection.exchange}: ${err.message}`);
        });
    }
}

export default {
    SUPPORTED_EXCHANGES,
    connectExchange,
    syncExchange,
    syncUserExchanges,
    encrypt,
    decrypt,
};
