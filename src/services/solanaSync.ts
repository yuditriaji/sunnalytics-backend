import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { logger } from './logger';

// Cast to any to avoid type conflicts during schema migration
const prisma = new PrismaClient() as any;

// Helius API (free tier: 1M credits/month)
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_API_URL = `https://api.helius.xyz/v0`;

// Jupiter API for token prices
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2';

// Solana address validation
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidSolanaAddress(address: string): boolean {
    return SOLANA_ADDRESS_REGEX.test(address);
}

interface TokenBalance {
    mint: string;
    amount: number;
    decimals: number;
    symbol?: string;
    name?: string;
    logoUrl?: string;
}

interface TokenPrice {
    [mint: string]: {
        price: number;
    };
}

/**
 * Fetch token balances for a Solana wallet using Helius
 */
export async function fetchSolanaBalances(address: string): Promise<TokenBalance[]> {
    if (!isValidSolanaAddress(address)) {
        throw new Error('Invalid Solana address');
    }

    if (!HELIUS_API_KEY) {
        throw new Error('HELIUS_API_KEY not configured');
    }

    try {
        // Use Helius getAssetsByOwner for comprehensive token data
        const response = await axios.post(
            HELIUS_RPC_URL,
            {
                jsonrpc: '2.0',
                id: 'get-assets',
                method: 'getAssetsByOwner',
                params: {
                    ownerAddress: address,
                    page: 1,
                    limit: 1000,
                    displayOptions: {
                        showFungible: true,
                        showNativeBalance: true,
                    },
                },
            },
            {
                timeout: 30000,
                headers: { 'Content-Type': 'application/json' },
            }
        );

        const assets = response.data?.result?.items || [];
        const nativeBalance = response.data?.result?.nativeBalance;

        const tokens: TokenBalance[] = [];

        // Add native SOL balance
        if (nativeBalance && nativeBalance.lamports > 0) {
            tokens.push({
                mint: 'So11111111111111111111111111111111111111112', // Wrapped SOL mint
                amount: nativeBalance.lamports / 1e9,
                decimals: 9,
                symbol: 'SOL',
                name: 'Solana',
                logoUrl: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
            });
        }

        // Add fungible tokens
        for (const asset of assets) {
            if (asset.interface === 'FungibleToken' || asset.interface === 'FungibleAsset') {
                const tokenInfo = asset.token_info || {};
                const balance = tokenInfo.balance || 0;
                const decimals = tokenInfo.decimals || 0;

                if (balance > 0) {
                    tokens.push({
                        mint: asset.id,
                        amount: balance / Math.pow(10, decimals),
                        decimals,
                        symbol: tokenInfo.symbol || asset.content?.metadata?.symbol || 'UNKNOWN',
                        name: asset.content?.metadata?.name || tokenInfo.symbol || 'Unknown Token',
                        logoUrl: asset.content?.links?.image || asset.content?.files?.[0]?.uri,
                    });
                }
            }
        }

        logger.info(`Fetched ${tokens.length} tokens for wallet ${address.slice(0, 8)}...`);
        return tokens;

    } catch (error: any) {
        logger.error(`Failed to fetch Solana balances for ${address}: ${error.message}`);
        throw error;
    }
}

/**
 * Fetch token prices from Jupiter
 */
export async function fetchTokenPrices(mints: string[]): Promise<TokenPrice> {
    if (mints.length === 0) return {};

    try {
        // Jupiter supports up to 100 tokens per request
        const response = await axios.get(JUPITER_PRICE_API, {
            params: { ids: mints.join(',') },
            timeout: 15000,
        });

        const prices: TokenPrice = {};
        const data = response.data?.data || {};

        for (const mint of mints) {
            if (data[mint]?.price) {
                prices[mint] = { price: data[mint].price };
            }
        }

        return prices;

    } catch (error: any) {
        logger.warn(`Failed to fetch prices from Jupiter: ${error.message}`);
        return {};
    }
}

/**
 * Sync a wallet's holdings to the database
 */
export async function syncWallet(walletId: string): Promise<void> {
    const wallet = await prisma.walletConnection.findUnique({
        where: { id: walletId },
    });

    if (!wallet) {
        throw new Error(`Wallet ${walletId} not found`);
    }

    if (wallet.chain !== 'solana') {
        throw new Error(`Chain ${wallet.chain} not supported yet`);
    }

    try {
        // Update sync status
        await prisma.walletConnection.update({
            where: { id: walletId },
            data: { syncStatus: 'syncing' },
        });

        // Fetch balances from Helius
        const balances = await fetchSolanaBalances(wallet.address);

        // Fetch prices from Jupiter
        const mints = balances.map((b) => b.mint);
        const prices = await fetchTokenPrices(mints);

        // Upsert holdings
        for (const token of balances) {
            const price = prices[token.mint]?.price || null;
            const valueUsd = price ? token.amount * price : null;

            await prisma.walletHolding.upsert({
                where: {
                    walletId_tokenMint: { walletId, tokenMint: token.mint },
                },
                update: {
                    symbol: token.symbol || 'UNKNOWN',
                    name: token.name,
                    logoUrl: token.logoUrl,
                    amount: token.amount,
                    decimals: token.decimals,
                    priceUsd: price,
                    valueUsd,
                    updatedAt: new Date(),
                },
                create: {
                    walletId,
                    tokenMint: token.mint,
                    symbol: token.symbol || 'UNKNOWN',
                    name: token.name,
                    logoUrl: token.logoUrl,
                    amount: token.amount,
                    decimals: token.decimals,
                    priceUsd: price,
                    valueUsd,
                },
            });
        }

        // Remove tokens that are no longer held
        const holdingMints = balances.map((b) => b.mint);
        await prisma.walletHolding.deleteMany({
            where: {
                walletId,
                tokenMint: { notIn: holdingMints },
            },
        });

        // Update sync status
        await prisma.walletConnection.update({
            where: { id: walletId },
            data: {
                syncStatus: 'success',
                lastSynced: new Date(),
                syncError: null,
            },
        });

        logger.info(`Successfully synced wallet ${wallet.address.slice(0, 8)}... (${balances.length} tokens)`);

    } catch (error: any) {
        // Update with error
        await prisma.walletConnection.update({
            where: { id: walletId },
            data: {
                syncStatus: 'error',
                syncError: error.message,
            },
        });

        logger.error(`Failed to sync wallet ${wallet.address}: ${error.message}`);
        throw error;
    }
}

/**
 * Sync all wallets for a user
 */
export async function syncUserWallets(userId: string): Promise<void> {
    const wallets = await prisma.walletConnection.findMany({
        where: { userId },
    });

    for (const wallet of wallets) {
        try {
            await syncWallet(wallet.id);
        } catch (error: any) {
            logger.error(`Failed to sync wallet ${wallet.id}: ${error.message}`);
            // Continue with other wallets
        }
    }
}

export default {
    isValidSolanaAddress,
    fetchSolanaBalances,
    fetchTokenPrices,
    syncWallet,
    syncUserWallets,
};
