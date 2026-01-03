import { z } from 'zod';
import { logger } from '../services/logger';

// Enhanced token schema with comprehensive validation
export const enhancedTokenSchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(100, 'Name too long')
    .refine(name => !/^\s+|\s+$/.test(name), 'Name cannot have leading/trailing spaces'),
  
  symbol: z.string()
    .min(1, 'Symbol is required')
    .max(20, 'Symbol too long')
    .regex(/^[A-Z0-9-]+$/, 'Symbol must contain only uppercase letters, numbers, and hyphens')
    .transform(s => s.toUpperCase()),
  
  category: z.enum(['memecoin', 'defi', 'altcoin'], { message: 'Invalid category' }),
  
  price: z.number()
    .positive('Price must be positive')
    .finite('Price must be finite')
    .refine(p => p < 1e10, 'Price seems unreasonably high')
    .optional(),
  
  marketCap: z.number()
    .positive('Market cap must be positive')
    .finite('Market cap must be finite')
    .refine(mc => mc > 1000, 'Market cap too low (possible data error)')
    .optional(),
  
  volume24h: z.number()
    .nonnegative('Volume cannot be negative')
    .finite('Volume must be finite')
    .optional(),
  
  transferVolume24h: z.number()
    .nonnegative('Transfer volume cannot be negative')
    .finite('Transfer volume must be finite')
    .optional(),
  
  contractAddress: z.string()
    .optional()
    .refine((addr) => {
      if (!addr) return true;
      // Ethereum address validation
      if (addr.startsWith('0x')) {
        return /^0x[a-fA-F0-9]{40}$/.test(addr);
      }
      // Solana address validation (base58, 32-44 chars typically)
      return /^[A-HJ-NP-Z1-9]{32,44}$/.test(addr);
    }, 'Invalid contract address format'),
  
  platform: z.enum(['solana', 'ethereum', 'polygon', 'arbitrum', 'optimism', 'avalanche', 'bnb'])
    .optional(),
  
  liquidityScore: z.number().min(0).max(100).optional(),
  pumpDumpRiskScore: z.number().min(0).max(100).optional(),
  walletDistributionScore: z.number().min(0).max(100).optional(),
  
  exchange: z.string()
    .optional()
    .refine(ex => !ex || /^[a-z,]+$/.test(ex), 'Exchange format should be comma-separated lowercase names')
});

// Price validation with market context
export const priceValidationSchema = z.object({
  price: z.number().positive(),
  marketCap: z.number().positive().optional(),
  volume24h: z.number().nonnegative().optional(),
  priceChange24h: z.number().optional()
}).refine(data => {
  // Cross-field validation: if we have marketCap and price, check for consistency
  if (data.marketCap && data.price) {
    const impliedSupply = data.marketCap / data.price;
    // Most tokens have supply between 1M and 1T
    if (impliedSupply < 1e6 || impliedSupply > 1e15) {
      return false;
    }
  }
  return true;
}, {
  message: "Price and market cap relationship seems inconsistent",
  path: ["price"]
});

// On-chain data validation
export const onChainDataSchema = z.object({
  walletDistributionScore: z.number().min(0).max(100).nullable(),
  poolLiquidity: z.number().positive().nullable(),
  txActivityScore: z.number().min(0).max(100).nullable(),
  transferVolume24h: z.number().nonnegative().nullable()
}).refine(data => {
  // At least one field should have valid data
  return Object.values(data).some(value => value !== null && value !== undefined);
}, {
  message: "At least one on-chain metric must be available",
});

// Environment validation with enhanced checks
export function validateEnhancedEnv() {
  const envSchema = z.object({
    PORT: z.string().regex(/^\d+$/).default('3001'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    
    DATABASE_URL: z.string()
      .url('Invalid database URL')
      .refine(url => url.startsWith('postgresql://'), 'Must be a PostgreSQL URL'),
    
    CORS_ORIGINS: z.string().optional(),
    
    // API Keys with validation
    BITQUERY_CLIENT_ID: z.string()
      .min(10, 'Bitquery client ID too short')
      .max(100, 'Bitquery client ID too long'),
    
    BITQUERY_CLIENT_SECRET: z.string()
      .min(20, 'Bitquery client secret too short')
      .max(200, 'Bitquery client secret too long'),
    
    ETHERSCAN_API_KEY: z.string()
      .regex(/^[A-Z0-9]{34}$/, 'Invalid Etherscan API key format')
      .optional(),
    
    BIRDEYE_API_KEY: z.string()
      .min(20, 'Birdeye API key too short')
      .optional(),
    
    SOLANA_RPC_URL: z.string()
      .url('Invalid Solana RPC URL')
      .default('https://api.mainnet-beta.solana.com')
      .refine(url => {
        // Validate it's a Solana RPC endpoint
        return url.includes('solana') || url.includes('mainnet') || url.includes('devnet');
      }, 'URL should be a valid Solana RPC endpoint'),
    
    // Rate limiting config
    RATE_LIMIT_WINDOW_MS: z.string().regex(/^\d+$/).default('900000'), // 15 minutes
    RATE_LIMIT_MAX_REQUESTS: z.string().regex(/^\d+$/).default('100'),
  });

  try {
    const validatedEnv = envSchema.parse(process.env);
    
    // Additional runtime checks
    const criticalMissing = [];
    if (!validatedEnv.BITQUERY_CLIENT_ID) criticalMissing.push('BITQUERY_CLIENT_ID');
    if (!validatedEnv.BITQUERY_CLIENT_SECRET) criticalMissing.push('BITQUERY_CLIENT_SECRET');
    
    if (criticalMissing.length > 0) {
      throw new Error(`Critical environment variables missing: ${criticalMissing.join(', ')}`);
    }
    
    logger.info('Environment validation successful', {
      nodeEnv: validatedEnv.NODE_ENV,
      hasEtherscan: !!validatedEnv.ETHERSCAN_API_KEY,
      hasBirdeye: !!validatedEnv.BIRDEYE_API_KEY,
      solanaRpc: validatedEnv.SOLANA_RPC_URL.includes('mainnet') ? 'mainnet' : 'other'
    });
    
    return validatedEnv;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join('\n');
      throw new Error(`Environment validation failed:\n${details}`);
    }
    throw error;
  }
}

// Data consistency validator
export class DataConsistencyValidator {
  
  static validateTokenDataConsistency(tokenData: any): { isValid: boolean; issues: string[] } {
    const issues: string[] = [];
    
    // Price vs Market Cap consistency
    if (tokenData.price && tokenData.marketCap) {
      const impliedSupply = tokenData.marketCap / tokenData.price;
      if (impliedSupply < 1000 || impliedSupply > 1e15) {
        issues.push(`Inconsistent price/marketCap ratio (implied supply: ${impliedSupply.toExponential(2)})`);
      }
    }
    
    // Volume vs Market Cap ratio check
    if (tokenData.volume24h && tokenData.marketCap) {
      const volumeRatio = tokenData.volume24h / tokenData.marketCap;
      if (volumeRatio > 10) {
        issues.push(`Unusually high volume/marketCap ratio: ${volumeRatio.toFixed(2)}`);
      }
    }
    
    // Platform vs Contract Address consistency
    if (tokenData.platform && tokenData.contractAddress) {
      const isEthereumAddress = tokenData.contractAddress.startsWith('0x');
      const isSolanaAddress = /^[A-HJ-NP-Z1-9]{32,44}$/.test(tokenData.contractAddress);
      
      if (tokenData.platform === 'ethereum' && !isEthereumAddress) {
        issues.push('Ethereum platform but non-Ethereum contract address');
      }
      if (tokenData.platform === 'solana' && !isSolanaAddress) {
        issues.push('Solana platform but non-Solana contract address');
      }
    }
    
    // Exchange validation
    if (tokenData.exchange) {
      const validExchanges = ['binance', 'bybit', 'mexc', 'htx', 'gate', 'kucoin', 'okx'];
      const exchanges = tokenData.exchange.toLowerCase().split(',');
      const invalidExchanges = exchanges.filter((ex: string) => !validExchanges.includes(ex.trim()));
      if (invalidExchanges.length > 0) {
        issues.push(`Invalid exchanges: ${invalidExchanges.join(', ')}`);
      }
    }
    
    // Score ranges
    ['liquidityScore', 'pumpDumpRiskScore', 'walletDistributionScore'].forEach(field => {
      if (tokenData[field] !== undefined && (tokenData[field] < 0 || tokenData[field] > 100)) {
        issues.push(`${field} should be between 0-100, got: ${tokenData[field]}`);
      }
    });
    
    return {
      isValid: issues.length === 0,
      issues
    };
  }
  
  static validatePriceMovement(currentPrice: number, previousPrice: number): { isValid: boolean; warning?: string } {
    if (!previousPrice || previousPrice <= 0) return { isValid: true };
    
    const changePercent = Math.abs((currentPrice - previousPrice) / previousPrice) * 100;
    
    // Flag extreme price movements (>1000% in one update)
    if (changePercent > 1000) {
      return {
        isValid: false,
        warning: `Extreme price change detected: ${changePercent.toFixed(2)}% (${previousPrice} -> ${currentPrice})`
      };
    }
    
    // Warn about significant movements (>100%)
    if (changePercent > 100) {
      return {
        isValid: true,
        warning: `Significant price change: ${changePercent.toFixed(2)}% (${previousPrice} -> ${currentPrice})`
      };
    }
    
    return { isValid: true };
  }
  
  static validateDataFreshness(timestamp: Date, maxAgeMinutes: number = 60): boolean {
    const ageMinutes = (Date.now() - timestamp.getTime()) / (1000 * 60);
    return ageMinutes <= maxAgeMinutes;
  }
}

// Comprehensive data sanitizer
export class DataSanitizer {
  static sanitizeTokenData(rawData: any): any {
    const sanitized = { ...rawData };
    
    // Ensure numbers are properly typed and finite
    ['price', 'marketCap', 'volume24h', 'transferVolume24h'].forEach(field => {
      if (sanitized[field] !== undefined) {
        const num = Number(sanitized[field]);
        sanitized[field] = (isFinite(num) && num >= 0) ? num : null;
      }
    });
    
    // Clean string fields
    if (sanitized.name) {
      sanitized.name = String(sanitized.name).trim().slice(0, 100);
    }
    if (sanitized.symbol) {
      sanitized.symbol = String(sanitized.symbol).trim().toUpperCase().slice(0, 20);
    }
    if (sanitized.contractAddress) {
      sanitized.contractAddress = String(sanitized.contractAddress).trim();
    }
    
    // Normalize exchange field
    if (sanitized.exchange) {
      sanitized.exchange = String(sanitized.exchange)
        .toLowerCase()
        .split(',')
        .map((ex: string) => ex.trim())
        .filter(Boolean)
        .join(',');
    }
    
    return sanitized;
  }
  
  static sanitizePriceData(price: any): number | null {
    const num = Number(price);
    if (!isFinite(num) || num <= 0 || num > 1e12) {
      return null;
    }
    return num;
  }
}