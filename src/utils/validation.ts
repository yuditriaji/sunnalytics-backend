import { z } from 'zod';

export const tokenSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  symbol: z.string().min(1, 'Symbol is required'),
  category: z.enum(['memecoin', 'defi', 'altcoin'], { message: 'Invalid category' }),
  marketCap: z.number().optional(),
  volume24h: z.number().optional(),
  price: z.number().optional(),
  transferVolume24h: z.number().optional(),
  liquidityScore: z.number().optional(),
  pumpDumpRiskScore: z.number().optional(),
  walletDistributionScore: z.number().optional(),
});

export function validateEnv() {
  const envSchema = z.object({
    PORT: z.string().default('3001'),
    DATABASE_URL: z.string().url(),
    CORS_ORIGINS: z.string().optional(),
    BITQUERY_CLIENT_ID: z.string().min(1, 'Bitquery client ID is required'),
    BITQUERY_CLIENT_SECRET: z.string().min(1, 'Bitquery client secret is required'),
    ETHERSCAN_API_KEY: z.string().optional(),
    SOLANA_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
  });

  try {
    envSchema.parse(process.env);
  } catch (error) {
    if (error && typeof error === 'object' && error !== null && 'errors' in error) {
      throw new Error(`Environment variable validation failed: ${JSON.stringify((error as any).errors, null, 2)}`);
    }
    throw error;
  }
}