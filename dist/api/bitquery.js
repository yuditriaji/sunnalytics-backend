"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchBitqueryTokens = fetchBitqueryTokens;
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../services/logger");
const cache_1 = require("../services/cache");
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const SOLANA_RPC_URLS = [
    process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com'
];
// Static token list for popular Solana tokens
const TOKEN_LIST = [
    {
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        name: 'USD Coin',
        symbol: 'USDC',
        coingeckoId: 'usd-coin'
    },
    {
        address: 'So11111111111111111111111111111111111111112',
        name: 'Wrapped SOL',
        symbol: 'SOL',
        coingeckoId: 'solana'
    },
    {
        address: 'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt',
        name: 'Serum',
        symbol: 'SRM',
        coingeckoId: 'serum'
    }
];
async function getTokenPrice(coingeckoId) {
    try {
        const response = await axios_1.default.get(`${COINGECKO_BASE}/simple/price`, {
            params: {
                ids: coingeckoId,
                vs_currencies: 'usd'
            },
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000
        });
        const price = response.data[coingeckoId]?.usd;
        if (typeof price !== 'number') {
            throw new Error(`Invalid price for ${coingeckoId}`);
        }
        return price;
    }
    catch (error) {
        logger_1.logger.error(`CoinGecko price fetch failed for ${coingeckoId}: ${error.message}`);
        return 0;
    }
}
async function getSolanaTokenMints() {
    try {
        const response = await axios_1.default.get(`${COINGECKO_BASE}/coins/markets`, {
            params: {
                vs_currency: 'usd',
                category: 'solana-ecosystem',
                per_page: 100,
                page: 1
            },
            timeout: 5000
        });
        return response.data
            .map((token) => token.platforms?.solana)
            .filter((address) => {
            try {
                return address && web3_js_1.PublicKey.isOnCurve(new web3_js_1.PublicKey(address));
            }
            catch {
                return false;
            }
        });
    }
    catch (error) {
        logger_1.logger.error(`Failed to fetch Solana token mints from CoinGecko: ${error.message}`);
        return TOKEN_LIST.map(t => t.address);
    }
}
async function isValidSplToken(connection, mintAddress) {
    try {
        const mintPubkey = new web3_js_1.PublicKey(mintAddress);
        const accountInfo = await connection.getAccountInfo(mintPubkey);
        return accountInfo?.owner.equals(spl_token_1.TOKEN_PROGRAM_ID) ?? false;
    }
    catch {
        return false;
    }
}
function isParsedInstruction(ix) {
    return ix && 'parsed' in ix && typeof ix.parsed === 'object';
}
async function fetchBitqueryTokens(maxRetries = 3) {
    const cacheKey = 'solana_tokens';
    const cachedData = cache_1.cache.get(cacheKey);
    if (cachedData) {
        logger_1.logger.info('Using cached Solana tokens');
        return cachedData;
    }
    const tokens = [];
    const tokenMints = await getSolanaTokenMints();
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const rpcUrl = SOLANA_RPC_URLS[(attempt - 1) % SOLANA_RPC_URLS.length];
        const connection = new web3_js_1.Connection(rpcUrl, 'confirmed');
        try {
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            for (const mintAddress of tokenMints.slice(0, 5)) {
                try {
                    if (!(await isValidSplToken(connection, mintAddress))) {
                        logger_1.logger.warn(`Invalid SPL token mint: ${mintAddress}`);
                        continue;
                    }
                    const mintPubkey = new web3_js_1.PublicKey(mintAddress);
                    const signatures = await connection.getSignaturesForAddress(mintPubkey, {
                        limit: 50
                    });
                    if (!signatures.length) {
                        logger_1.logger.warn(`No recent transfers for mint ${mintAddress} on ${rpcUrl}`);
                        continue;
                    }
                    let tokenInfo = TOKEN_LIST.find(t => t.address === mintAddress);
                    if (!tokenInfo) {
                        const cgResponse = await axios_1.default.get(`${COINGECKO_BASE}/coins/markets`, {
                            params: {
                                vs_currency: 'usd',
                                category: 'solana-ecosystem',
                                per_page: 100,
                                page: 1
                            }
                        });
                        const cgToken = cgResponse.data.find((t) => t.platforms?.solana === mintAddress);
                        if (cgToken) {
                            tokenInfo = {
                                address: mintAddress,
                                name: cgToken.name || 'Unknown',
                                symbol: cgToken.symbol.toUpperCase() || 'UNKNOWN',
                                coingeckoId: cgToken.id
                            };
                        }
                        else {
                            logger_1.logger.warn(`No metadata for mint ${mintAddress}`);
                            continue;
                        }
                    }
                    const price = await getTokenPrice(tokenInfo.coingeckoId);
                    for (const sig of signatures.slice(0, 10)) {
                        try {
                            const tx = await connection.getParsedTransaction(sig.signature, {
                                maxSupportedTransactionVersion: 0
                            });
                            if (!tx) {
                                logger_1.logger.warn(`Transaction ${sig.signature} not found`);
                                continue;
                            }
                            let transferFound = false;
                            for (const ix of tx.transaction.message.instructions) {
                                if ('programId' in ix && ix.programId.equals(spl_token_1.TOKEN_PROGRAM_ID) && isParsedInstruction(ix)) {
                                    const parsedInfo = ix.parsed;
                                    if (parsedInfo.type === 'transfer' && parsedInfo.info.mint === mintAddress) {
                                        tokens.push({
                                            address: mintAddress,
                                            name: tokenInfo.name,
                                            symbol: tokenInfo.symbol,
                                            price
                                        });
                                        transferFound = true;
                                        break;
                                    }
                                }
                            }
                            if (!transferFound) {
                                logger_1.logger.debug(`No SPL transfer in transaction ${sig.signature} for mint ${mintAddress}`);
                            }
                        }
                        catch (error) {
                            logger_1.logger.warn(`Error parsing transaction ${sig.signature}: ${error.message}`);
                        }
                    }
                }
                catch (error) {
                    logger_1.logger.warn(`Error processing mint ${mintAddress} on ${rpcUrl}: ${error.message}`);
                }
            }
            const uniqueTokens = Array.from(new Map(tokens.map(t => [t.address, t])).values()).slice(0, 100);
            if (!uniqueTokens.length) {
                logger_1.logger.warn('No valid Solana token transfers found after processing');
                return [];
            }
            logger_1.logger.info(`Solana RPC call successful, attempt ${attempt}, fetched ${uniqueTokens.length} tokens on ${rpcUrl}`);
            cache_1.cache.set(cacheKey, uniqueTokens, 300);
            return uniqueTokens;
        }
        catch (error) {
            logger_1.logger.error(`Solana RPC error, attempt ${attempt} on ${rpcUrl}: ${error.message}`);
            if (attempt === maxRetries)
                throw new Error('Failed to fetch Solana data after retries');
        }
    }
    throw new Error('Unexpected error in fetchBitqueryTokens');
}
