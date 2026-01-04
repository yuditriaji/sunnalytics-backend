import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { logger } from './logger';

// Cast to any for schema migration compatibility
const prisma = new PrismaClient() as any;

// EVM Chain Configuration
// Note: Etherscan operates all these explorers - unified API key works across all
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';

const EVM_CHAINS = {
    ethereum: {
        name: 'Ethereum',
        chainId: 1,
        rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
        nativeSymbol: 'ETH',
        nativeDecimals: 18,
        explorerApi: 'https://api.etherscan.io/api',
        apiKey: process.env.ETHERSCAN_API_KEY || '',
    },
    base: {
        name: 'Base',
        chainId: 8453,
        rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
        nativeSymbol: 'ETH',
        nativeDecimals: 18,
        explorerApi: 'https://api.basescan.org/api',
        apiKey: ETHERSCAN_API_KEY, // Unified Etherscan API
    },
    arbitrum: {
        name: 'Arbitrum',
        chainId: 42161,
        rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
        nativeSymbol: 'ETH',
        nativeDecimals: 18,
        explorerApi: 'https://api.arbiscan.io/api',
        apiKey: ETHERSCAN_API_KEY, // Unified Etherscan API
    },
    bsc: {
        name: 'BNB Chain',
        chainId: 56,
        rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
        nativeSymbol: 'BNB',
        nativeDecimals: 18,
        explorerApi: 'https://api.bscscan.com/api',
        apiKey: ETHERSCAN_API_KEY, // Unified Etherscan API
    },
};

type EvmChainKey = keyof typeof EVM_CHAINS;

// EVM address validation
const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export function isValidEvmAddress(address: string): boolean {
    return EVM_ADDRESS_REGEX.test(address);
}

interface TokenBalance {
    contractAddress: string;
    symbol: string;
    name: string;
    decimals: number;
    balance: string;
    logoUrl?: string;
}

interface TokenPrice {
    [address: string]: number;
}

/**
 * Fetch native balance (ETH, BNB) using RPC
 */
async function fetchNativeBalance(chain: EvmChainKey, address: string): Promise<string> {
    const config = EVM_CHAINS[chain];

    try {
        const response = await axios.post(
            config.rpcUrl,
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_getBalance',
                params: [address, 'latest'],
            },
            { timeout: 10000 }
        );

        const balanceHex = response.data?.result || '0x0';
        return BigInt(balanceHex).toString();
    } catch (error: any) {
        logger.warn(`Failed to fetch native balance for ${chain}: ${error.message}`);
        return '0';
    }
}

/**
 * Fetch ERC-20 token balances using explorer API
 */
async function fetchTokenBalances(chain: EvmChainKey, address: string): Promise<TokenBalance[]> {
    const config = EVM_CHAINS[chain];

    if (!config.apiKey) {
        logger.warn(`No API key for ${chain}, skipping token fetch`);
        return [];
    }

    try {
        const response = await axios.get(config.explorerApi, {
            params: {
                module: 'account',
                action: 'tokentx',
                address,
                page: 1,
                offset: 100,
                sort: 'desc',
                apikey: config.apiKey,
            },
            timeout: 15000,
        });

        if (response.data.status !== '1') {
            return [];
        }

        const transactions = response.data.result || [];

        // Get unique tokens from transactions
        const tokenMap = new Map<string, TokenBalance>();

        for (const tx of transactions) {
            if (!tokenMap.has(tx.contractAddress)) {
                tokenMap.set(tx.contractAddress, {
                    contractAddress: tx.contractAddress,
                    symbol: tx.tokenSymbol,
                    name: tx.tokenName,
                    decimals: parseInt(tx.tokenDecimal) || 18,
                    balance: '0',
                });
            }
        }

        // Fetch current balances for each token
        for (const [contractAddress, token] of tokenMap) {
            try {
                const balanceResponse = await axios.get(config.explorerApi, {
                    params: {
                        module: 'account',
                        action: 'tokenbalance',
                        contractaddress: contractAddress,
                        address,
                        tag: 'latest',
                        apikey: config.apiKey,
                    },
                    timeout: 10000,
                });

                if (balanceResponse.data.status === '1') {
                    token.balance = balanceResponse.data.result || '0';
                }
            } catch {
                // Skip failed balance fetches
            }
        }

        // Filter out zero balances
        return Array.from(tokenMap.values()).filter(
            (t) => BigInt(t.balance) > BigInt(0)
        );
    } catch (error: any) {
        logger.warn(`Failed to fetch token balances for ${chain}: ${error.message}`);
        return [];
    }
}

/**
 * Fetch token prices from CoinGecko (supports EVM tokens)
 */
async function fetchEvmTokenPrices(
    chain: EvmChainKey,
    contractAddresses: string[]
): Promise<TokenPrice> {
    if (contractAddresses.length === 0) return {};

    const platformMap: { [key: string]: string } = {
        ethereum: 'ethereum',
        base: 'base',
        arbitrum: 'arbitrum-one',
        bsc: 'binance-smart-chain',
    };

    const platform = platformMap[chain];
    if (!platform) return {};

    try {
        const addresses = contractAddresses.slice(0, 25).join(','); // Limit to 25

        const response = await axios.get(
            `https://api.coingecko.com/api/v3/simple/token_price/${platform}`,
            {
                params: {
                    contract_addresses: addresses,
                    vs_currencies: 'usd',
                },
                timeout: 15000,
            }
        );

        const prices: TokenPrice = {};
        for (const [address, data] of Object.entries(response.data || {})) {
            prices[address.toLowerCase()] = (data as any).usd || 0;
        }

        return prices;
    } catch (error: any) {
        logger.warn(`Failed to fetch EVM token prices: ${error.message}`);
        return {};
    }
}

/**
 * Fetch native token price (ETH, BNB)
 */
async function fetchNativePrice(symbol: string): Promise<number> {
    try {
        const idMap: { [key: string]: string } = {
            ETH: 'ethereum',
            BNB: 'binancecoin',
        };

        const id = idMap[symbol];
        if (!id) return 0;

        const response = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price',
            {
                params: { ids: id, vs_currencies: 'usd' },
                timeout: 10000,
            }
        );

        return response.data?.[id]?.usd || 0;
    } catch {
        return 0;
    }
}

/**
 * Sync an EVM wallet's holdings to the database
 */
export async function syncEvmWallet(walletId: string): Promise<void> {
    const wallet = await prisma.walletConnection.findUnique({
        where: { id: walletId },
    });

    if (!wallet) {
        throw new Error(`Wallet ${walletId} not found`);
    }

    const chain = wallet.chain as EvmChainKey;
    if (!EVM_CHAINS[chain]) {
        throw new Error(`Chain ${chain} not supported for EVM sync`);
    }

    const config = EVM_CHAINS[chain];

    try {
        // Update sync status
        await prisma.walletConnection.update({
            where: { id: walletId },
            data: { syncStatus: 'syncing' },
        });

        // Fetch native balance
        const nativeBalanceWei = await fetchNativeBalance(chain, wallet.address);
        const nativeBalance = parseFloat(nativeBalanceWei) / Math.pow(10, config.nativeDecimals);
        const nativePrice = await fetchNativePrice(config.nativeSymbol);

        // Fetch ERC-20 token balances
        const tokenBalances = await fetchTokenBalances(chain, wallet.address);

        // Fetch prices for tokens
        const contractAddresses = tokenBalances.map((t) => t.contractAddress.toLowerCase());
        const tokenPrices = await fetchEvmTokenPrices(chain, contractAddresses);

        // Upsert native token holding
        if (nativeBalance > 0) {
            await prisma.walletHolding.upsert({
                where: {
                    walletId_tokenMint: { walletId, tokenMint: 'native' },
                },
                update: {
                    symbol: config.nativeSymbol,
                    name: config.name,
                    amount: nativeBalance,
                    decimals: config.nativeDecimals,
                    priceUsd: nativePrice,
                    valueUsd: nativeBalance * nativePrice,
                    updatedAt: new Date(),
                },
                create: {
                    walletId,
                    tokenMint: 'native',
                    symbol: config.nativeSymbol,
                    name: config.name,
                    amount: nativeBalance,
                    decimals: config.nativeDecimals,
                    priceUsd: nativePrice,
                    valueUsd: nativeBalance * nativePrice,
                },
            });
        }

        // Upsert ERC-20 token holdings
        for (const token of tokenBalances) {
            const amount = parseFloat(token.balance) / Math.pow(10, token.decimals);
            const price = tokenPrices[token.contractAddress.toLowerCase()] || null;
            const valueUsd = price ? amount * price : null;

            await prisma.walletHolding.upsert({
                where: {
                    walletId_tokenMint: { walletId, tokenMint: token.contractAddress },
                },
                update: {
                    symbol: token.symbol,
                    name: token.name,
                    amount,
                    decimals: token.decimals,
                    priceUsd: price,
                    valueUsd,
                    updatedAt: new Date(),
                },
                create: {
                    walletId,
                    tokenMint: token.contractAddress,
                    symbol: token.symbol,
                    name: token.name,
                    amount,
                    decimals: token.decimals,
                    priceUsd: price,
                    valueUsd,
                },
            });
        }

        // Remove tokens that are no longer held
        const holdingMints = ['native', ...tokenBalances.map((t) => t.contractAddress)];
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

        logger.info(`Successfully synced EVM wallet ${wallet.address.slice(0, 10)}... on ${chain}`);
    } catch (error: any) {
        // Update with error
        await prisma.walletConnection.update({
            where: { id: walletId },
            data: {
                syncStatus: 'error',
                syncError: error.message,
            },
        });

        logger.error(`Failed to sync EVM wallet ${wallet.address}: ${error.message}`);
        throw error;
    }
}

export default {
    isValidEvmAddress,
    syncEvmWallet,
    EVM_CHAINS,
};
