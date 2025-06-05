"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchMarketData = fetchMarketData;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../services/logger");
const BASE = 'https://api.coingecko.com/api/v3';
async function fetchMarketData(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Random delay to avoid rate limits (1-3 seconds)
            await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));
            const res = await axios_1.default.get(`${BASE}/coins/markets`, {
                params: {
                    vs_currency: 'usd',
                    order: 'market_cap_desc',
                    per_page: 100,
                    page: 1,
                    sparkline: false
                },
                timeout: 10000
            });
            logger_1.logger.info(`CoinGecko API call successful, attempt ${attempt}`);
            return res.data;
        }
        catch (error) {
            logger_1.logger.error(`CoinGecko API error, attempt ${attempt}: ${error.message}`);
            if (attempt === maxRetries)
                throw new Error('Failed to fetch CoinGecko data after retries');
        }
    }
    throw new Error('Unexpected error in fetchMarketData');
}
