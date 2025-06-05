import { z } from 'zod';

export const tokenSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  symbol: z.string().min(1, 'Symbol is required'),
  category: z.enum(['memecoin', 'defi', 'altcoin'], { message: 'Invalid category' }),
  marketCap: z.number().optional(),
  volume24h: z.number().optional(),
  price: z.number().int().optional() // Changed integer() to int()
});

export function validateEnv() {
  const envSchema = z.object({
    PORT: z.string().default('3001'),
    DATABASE_URL: z.string().url(),
    CORS_ORIGINS: z.string().optional(),
    BITQUERY_CLIENT_ID: z.string().min(1, 'Bitquery client ID is required'),
    BITQUERY_CLIENT_SECRET: z.string().min(1, 'Bitquery client secret is required')
  });

  try {
    envSchema.parse(process.env); // Added process.env
  } catch (error) {
    if (error && typeof error === 'object' && 'errors' in error) {
      throw new Error(`Environment variable validation failed: ${JSON.stringify((error as any).errors, null, 2)}`);
    }
    throw error;
  }
}