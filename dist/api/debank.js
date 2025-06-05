"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchDeBankTokens = fetchDeBankTokens;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../services/logger");
const BASE = 'https://openapi.debank.com/v1';
async function fetchDeBankTokens(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Random delay to avoid rate limits (2-4 seconds)
            await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 2000));
            const res = await axios_1.default.get(`${BASE}/token/list`, {
                params: { chain_id: 'eth' },
                timeout: 10000
            });
            logger_1.logger.info(`DeBank API call successful, attempt ${attempt}`);
            return res.data;
        }
        catch (error) {
            logger_1.logger.error(`DeBank API error, attempt ${attempt}: ${error.message}`);
            if (attempt === maxRetries)
                throw new Error('Failed to fetch DeBank data after retries');
        }
    }
    throw new Error('Unexpected error in fetchDeBankTokens');
}
