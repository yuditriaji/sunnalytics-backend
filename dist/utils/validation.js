"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenSchema = void 0;
exports.validateEnv = validateEnv;
const zod_1 = require("zod");
exports.tokenSchema = zod_1.z.object({
    name: zod_1.z.string().min(1, 'Name is required'),
    symbol: zod_1.z.string().min(1, 'Symbol is required'),
    category: zod_1.z.enum(['memecoin', 'defi', 'altcoin'], { message: 'Invalid category' }),
    marketCap: zod_1.z.number().optional(),
    volume24h: zod_1.z.number().optional(),
    price: zod_1.z.number().int().optional() // Changed integer() to int()
});
function validateEnv() {
    const envSchema = zod_1.z.object({
        PORT: zod_1.z.string().default('3001'),
        DATABASE_URL: zod_1.z.string().url(),
        CORS_ORIGINS: zod_1.z.string().optional(),
        BITQUERY_CLIENT_ID: zod_1.z.string().min(1, 'Bitquery client ID is required'),
        BITQUERY_CLIENT_SECRET: zod_1.z.string().min(1, 'Bitquery client secret is required')
    });
    try {
        envSchema.parse(process.env); // Added process.env
    }
    catch (error) {
        if (error && typeof error === 'object' && 'errors' in error) {
            throw new Error(`Environment variable validation failed: ${JSON.stringify(error.errors, null, 2)}`);
        }
        throw error;
    }
}
