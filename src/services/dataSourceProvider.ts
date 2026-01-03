/**
 * Data Source Provider Abstraction
 * 
 * This module provides a clean abstraction over multiple data sources,
 * allowing you to switch providers without changing business logic.
 * 
 * Architecture:
 * - Tier 1 (Direct): Helius (Solana), Moralis (EVM) - for on-chain analytics
 * - Tier 2 (DEX): Birdeye (Solana DEX), Jupiter (Solana swaps)
 * - Tier 3 (Aggregator): CoinGecko - for market data fallback
 */

import { logger } from './logger';
import { cache } from './cache';

// =============================================================================
// PROVIDER CONFIGURATION
// =============================================================================

export interface DataSourceConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  rateLimit: {
    requestsPerMinute: number;
    requestsPerDay?: number;
  };
  priority: number; // Lower = higher priority
  supportedChains: string[];
}

export const DATA_SOURCES: Record<string, DataSourceConfig> = {
  // Tier 1: Direct On-Chain (Your Differentiators)
  helius: {
    name: 'Helius',
    baseUrl: 'https://api.helius.xyz',
    apiKey: process.env.HELIUS_API_KEY,
    rateLimit: { requestsPerMinute: 100, requestsPerDay: 10000 },
    priority: 1,
    supportedChains: ['solana'],
  },
  moralis: {
    name: 'Moralis',
    baseUrl: 'https://deep-index.moralis.io/api/v2.2',
    apiKey: process.env.MORALIS_API_KEY,
    rateLimit: { requestsPerMinute: 25 },
    priority: 1,
    supportedChains: ['ethereum', 'bsc', 'base', 'arbitrum', 'polygon'],
  },

  // Tier 2: DEX Data
  birdeye: {
    name: 'Birdeye',
    baseUrl: 'https://public-api.birdeye.so',
    apiKey: process.env.BIRDEYE_API_KEY,
    rateLimit: { requestsPerMinute: 100 },
    priority: 2,
    supportedChains: ['solana'],
  },
  jupiter: {
    name: 'Jupiter',
    baseUrl: 'https://price.jup.ag/v6',
    rateLimit: { requestsPerMinute: 600 },
    priority: 2,
    supportedChains: ['solana'],
  },
  dexscreener: {
    name: 'DEXScreener',
    baseUrl: 'https://api.dexscreener.com/latest',
    rateLimit: { requestsPerMinute: 300 },
    priority: 2,
    supportedChains: ['solana', 'ethereum', 'bsc', 'base', 'arbitrum'],
  },

  // Tier 3: Aggregators (Fallback)
  coingecko: {
    name: 'CoinGecko',
    baseUrl: 'https://api.coingecko.com/api/v3',
    apiKey: process.env.COINGECKO_API_KEY,
    rateLimit: { requestsPerMinute: 10, requestsPerDay: 10000 },
    priority: 3,
    supportedChains: ['*'], // All chains
  },
};

// =============================================================================
// CHAIN CONFIGURATION
// =============================================================================

export interface ChainConfig {
  id: string;
  name: string;
  nativeToken: string;
  rpcUrl: string;
  explorerUrl: string;
  dexScreenerId: string;
  isActive: boolean;
}

export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  solana: {
    id: 'solana',
    name: 'Solana',
    nativeToken: 'SOL',
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    explorerUrl: 'https://solscan.io',
    dexScreenerId: 'solana',
    isActive: true,
  },
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    nativeToken: 'ETH',
    rpcUrl: process.env.ETH_RPC_URL || 'https://eth.llamarpc.com',
    explorerUrl: 'https://etherscan.io',
    dexScreenerId: 'ethereum',
    isActive: true,
  },
  bsc: {
    id: 'bsc',
    name: 'BNB Chain',
    nativeToken: 'BNB',
    rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
    explorerUrl: 'https://bscscan.com',
    dexScreenerId: 'bsc',
    isActive: false, // Enable when ready
  },
  base: {
    id: 'base',
    name: 'Base',
    nativeToken: 'ETH',
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    dexScreenerId: 'base',
    isActive: false,
  },
  arbitrum: {
    id: 'arbitrum',
    name: 'Arbitrum',
    nativeToken: 'ETH',
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    dexScreenerId: 'arbitrum',
    isActive: false,
  },
};

// =============================================================================
// DATA SOURCE INTERFACE
// =============================================================================

export interface TokenPrice {
  price: number;
  priceChange24h?: number;
  volume24h?: number;
  marketCap?: number;
  fdv?: number;
  source: string;
  timestamp: Date;
}

export interface OnChainAnalytics {
  holderCount?: number;
  top10HolderPercent?: number;
  walletDistributionScore?: number;
  whaleTransactions24h?: number;
  poolLiquidity?: number;
  source: string;
}

export interface DEXData {
  price: number;
  liquidity?: number;
  volume24h?: number;
  priceChange24h?: number;
  pairs?: {
    pairAddress: string;
    dex: string;
    baseToken: string;
    quoteToken: string;
    liquidity: number;
  }[];
  source: string;
}

// =============================================================================
// DATA SOURCE PROVIDER CLASS
// =============================================================================

export class DataSourceProvider {
  private static instance: DataSourceProvider;

  private constructor() {}

  static getInstance(): DataSourceProvider {
    if (!DataSourceProvider.instance) {
      DataSourceProvider.instance = new DataSourceProvider();
    }
    return DataSourceProvider.instance;
  }

  /**
   * Get the best available data source for a chain
   */
  getProviderForChain(chain: string, dataType: 'price' | 'onchain' | 'dex'): DataSourceConfig | null {
    const sources = Object.values(DATA_SOURCES)
      .filter(s => s.supportedChains.includes(chain) || s.supportedChains.includes('*'))
      .sort((a, b) => a.priority - b.priority);

    if (dataType === 'onchain') {
      // Prefer Helius for Solana, Moralis for EVM
      return sources.find(s => s.name === (chain === 'solana' ? 'Helius' : 'Moralis')) || sources[0];
    }

    if (dataType === 'dex') {
      // Prefer Birdeye for Solana, DEXScreener for others
      return sources.find(s => 
        chain === 'solana' ? s.name === 'Birdeye' : s.name === 'DEXScreener'
      ) || sources[0];
    }

    // For price, use DEX sources first, then aggregators
    return sources[0];
  }

  /**
   * Get chain configuration
   */
  getChainConfig(chain: string): ChainConfig | null {
    return CHAIN_CONFIGS[chain] || null;
  }

  /**
   * Get all active chains
   */
  getActiveChains(): ChainConfig[] {
    return Object.values(CHAIN_CONFIGS).filter(c => c.isActive);
  }

  /**
   * Check if a data source is available
   */
  isSourceAvailable(sourceName: string): boolean {
    const source = DATA_SOURCES[sourceName.toLowerCase()];
    if (!source) return false;
    
    // Check if API key is required and present
    if (sourceName === 'helius' && !process.env.HELIUS_API_KEY) return false;
    if (sourceName === 'moralis' && !process.env.MORALIS_API_KEY) return false;
    if (sourceName === 'birdeye' && !process.env.BIRDEYE_API_KEY) return false;
    
    return true;
  }

  /**
   * Get recommended data fetching strategy for a chain
   */
  getDataStrategy(chain: string): {
    priceSource: string;
    onchainSource: string;
    dexSource: string;
    fallbackSource: string;
  } {
    if (chain === 'solana') {
      return {
        priceSource: this.isSourceAvailable('birdeye') ? 'birdeye' : 'jupiter',
        onchainSource: this.isSourceAvailable('helius') ? 'helius' : 'solana-rpc',
        dexSource: this.isSourceAvailable('birdeye') ? 'birdeye' : 'dexscreener',
        fallbackSource: 'coingecko',
      };
    }

    // EVM chains
    return {
      priceSource: 'dexscreener',
      onchainSource: this.isSourceAvailable('moralis') ? 'moralis' : 'etherscan',
      dexSource: 'dexscreener',
      fallbackSource: 'coingecko',
    };
  }
}

export const dataSourceProvider = DataSourceProvider.getInstance();
