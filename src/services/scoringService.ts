import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

const prisma = new PrismaClient();

// RPC endpoints
const SOLANA_RPC = process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

const ETHERSCAN_API = 'https://api.etherscan.io/api';
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';
const BIRDEYE_API = 'https://public-api.birdeye.so';

interface ScoreResult {
    liquidityScore: number;
    walletDistributionScore: number;
    pumpDumpRiskScore: number;
    transferVolume24h?: number;
    top10HolderPercent?: number;
}

/**
 * Get liquidity data from DexScreener (multi-chain, free)
 */
async function fetchDexScreenerLiquidity(contractAddress: string): Promise<{ liquidity: number; volume24h: number } | null> {
    try {
        const response = await axios.get(`${DEXSCREENER_API}/${contractAddress}`, {
            timeout: 10000
        });

        const pairs = response.data?.pairs || [];
        if (pairs.length === 0) return null;

        // Sum liquidity from all pairs, take highest volume pair
        let totalLiquidity = 0;
        let maxVolume24h = 0;

        for (const pair of pairs.slice(0, 5)) { // Top 5 pairs
            totalLiquidity += pair.liquidity?.usd || 0;
            const vol = pair.volume?.h24 || 0;
            if (vol > maxVolume24h) maxVolume24h = vol;
        }

        return { liquidity: totalLiquidity, volume24h: maxVolume24h };
    } catch (error: any) {
        // Silent fail - many tokens won't have DEX pairs
        return null;
    }
}

/**
 * Calculate liquidity score (0-100)
 * Based on DEX liquidity depth
 */
function calculateLiquidityScore(liquidityUsd: number, marketCap: number): number {
    if (!liquidityUsd || liquidityUsd <= 0) return 0;

    // Liquidity to market cap ratio
    const ratio = marketCap > 0 ? liquidityUsd / marketCap : 0;

    // Score based on absolute liquidity + ratio
    let score = 0;

    // Absolute liquidity component (0-50 points)
    if (liquidityUsd >= 10000000) score += 50;      // $10M+
    else if (liquidityUsd >= 1000000) score += 40;   // $1M+
    else if (liquidityUsd >= 100000) score += 30;    // $100K+
    else if (liquidityUsd >= 10000) score += 20;     // $10K+
    else if (liquidityUsd >= 1000) score += 10;      // $1K+

    // Ratio component (0-50 points)
    if (ratio >= 0.10) score += 50;        // 10%+ of market cap
    else if (ratio >= 0.05) score += 40;   // 5%+
    else if (ratio >= 0.02) score += 30;   // 2%+
    else if (ratio >= 0.01) score += 20;   // 1%+
    else if (ratio >= 0.005) score += 10;  // 0.5%+

    return Math.min(score, 100);
}

/**
 * Get Solana holder distribution
 */
async function getSolanaHolderDistribution(contractAddress: string): Promise<{ top10Percent: number; holderCount: number } | null> {
    try {
        const connection = new Connection(SOLANA_RPC, 'confirmed');
        const mintPubkey = new PublicKey(contractAddress);

        // Get largest accounts (top holders)
        const accounts = await connection.getTokenLargestAccounts(mintPubkey);
        if (!accounts.value || accounts.value.length === 0) return null;

        // Get total supply
        const supplyInfo = await connection.getTokenSupply(mintPubkey);
        const totalSupply = parseFloat(supplyInfo.value.amount);
        if (totalSupply === 0) return null;

        // Calculate top 10 holder percentage
        const top10Holdings = accounts.value
            .slice(0, 10)
            .reduce((sum, acc) => sum + parseFloat(acc.amount), 0);

        const top10Percent = (top10Holdings / totalSupply) * 100;

        return {
            top10Percent,
            holderCount: accounts.value.length
        };
    } catch (error: any) {
        logger.debug(`Solana holder fetch failed for ${contractAddress}: ${error.message}`);
        return null;
    }
}

/**
 * Get Ethereum holder distribution via Etherscan
 */
async function getEthereumHolderDistribution(contractAddress: string): Promise<{ top10Percent: number } | null> {
    if (!process.env.ETHERSCAN_API_KEY) return null;

    try {
        // Get token supply
        const supplyResponse = await axios.get(ETHERSCAN_API, {
            params: {
                module: 'stats',
                action: 'tokensupply',
                contractaddress: contractAddress,
                apikey: process.env.ETHERSCAN_API_KEY
            },
            timeout: 10000
        });

        if (supplyResponse.data.status !== '1') return null;
        const totalSupply = parseFloat(supplyResponse.data.result);
        if (totalSupply === 0) return null;

        // Get top token holders (only available for some tokens)
        const holdersResponse = await axios.get(ETHERSCAN_API, {
            params: {
                module: 'token',
                action: 'tokenholderlist',
                contractaddress: contractAddress,
                page: 1,
                offset: 10,
                apikey: process.env.ETHERSCAN_API_KEY
            },
            timeout: 10000
        });

        if (holdersResponse.data.status === '1' && holdersResponse.data.result?.length > 0) {
            const top10Holdings = holdersResponse.data.result
                .slice(0, 10)
                .reduce((sum: number, h: any) => sum + parseFloat(h.TokenHolderQuantity || 0), 0);

            return { top10Percent: (top10Holdings / totalSupply) * 100 };
        }

        // Fallback: estimate from recent transfers
        const transfersResponse = await axios.get(ETHERSCAN_API, {
            params: {
                module: 'account',
                action: 'tokentx',
                contractaddress: contractAddress,
                page: 1,
                offset: 100,
                sort: 'desc',
                apikey: process.env.ETHERSCAN_API_KEY
            },
            timeout: 10000
        });

        if (transfersResponse.data.status === '1' && transfersResponse.data.result?.length > 0) {
            // Estimate distribution from transfer activity
            const uniqueAddresses = new Set<string>();
            for (const tx of transfersResponse.data.result) {
                uniqueAddresses.add(tx.to);
                uniqueAddresses.add(tx.from);
            }

            // More unique addresses in recent transfers = better distribution
            const distributionScore = Math.min(uniqueAddresses.size, 100);
            return { top10Percent: 100 - distributionScore }; // Inverse: more addresses = lower concentration
        }

        return null;
    } catch (error: any) {
        logger.debug(`Etherscan holder fetch failed for ${contractAddress}: ${error.message}`);
        return null;
    }
}

/**
 * Calculate wallet distribution score (0-100)
 * Higher score = more distributed (less concentrated)
 */
function calculateWalletDistributionScore(top10Percent: number): number {
    if (top10Percent === 0) return 0;

    // Lower concentration = higher score
    if (top10Percent <= 10) return 100;      // Excellent distribution
    if (top10Percent <= 20) return 90;
    if (top10Percent <= 30) return 80;
    if (top10Percent <= 40) return 70;
    if (top10Percent <= 50) return 60;
    if (top10Percent <= 60) return 50;
    if (top10Percent <= 70) return 40;
    if (top10Percent <= 80) return 30;
    if (top10Percent <= 90) return 20;
    return 10; // Very concentrated
}

/**
 * Calculate pump & dump risk score (0-100)
 * Higher score = higher risk
 */
function calculatePumpDumpRiskScore(
    volumeMarketCapRatio: number,
    walletDistributionScore: number,
    liquidityScore: number,
    priceChange24h: number = 0
): number {
    let riskScore = 0;

    // 1. Volume/MarketCap ratio risk (0-25 points)
    // Very high ratio can indicate wash trading or manipulation
    if (volumeMarketCapRatio > 2.0) riskScore += 25;       // Extremely high
    else if (volumeMarketCapRatio > 1.0) riskScore += 20;  // Very high
    else if (volumeMarketCapRatio > 0.5) riskScore += 15;  // High
    else if (volumeMarketCapRatio > 0.2) riskScore += 10;  // Moderate
    else if (volumeMarketCapRatio < 0.01) riskScore += 5;  // Very low (illiquid)

    // 2. Wallet concentration risk (0-30 points)
    // Low distribution score = high concentration = high risk
    const concentrationRisk = Math.max(0, 30 - (walletDistributionScore * 0.3));
    riskScore += concentrationRisk;

    // 3. Liquidity risk (0-25 points)
    // Low liquidity = easy to manipulate
    const liquidityRisk = Math.max(0, 25 - (liquidityScore * 0.25));
    riskScore += liquidityRisk;

    // 4. Price volatility risk (0-20 points)
    const absChange = Math.abs(priceChange24h);
    if (absChange > 50) riskScore += 20;       // Extreme move
    else if (absChange > 30) riskScore += 15;  // Very volatile
    else if (absChange > 20) riskScore += 10;  // Volatile
    else if (absChange > 10) riskScore += 5;   // Moderate

    return Math.min(Math.round(riskScore), 100);
}

/**
 * Calculate all scores for a single token
 */
async function calculateTokenScores(token: {
    id: string;
    symbol: string;
    chain: string;
    contractAddress: string;
    marketCap: number | null;
    volume24h: number | null;
    priceChange24h: number | null;
}): Promise<ScoreResult | null> {
    try {
        const marketCap = token.marketCap || 0;
        const volume24h = token.volume24h || 0;
        const priceChange24h = token.priceChange24h || 0;
        const volumeMarketCapRatio = marketCap > 0 ? volume24h / marketCap : 0;

        // 1. Get liquidity from DexScreener
        const dexData = await fetchDexScreenerLiquidity(token.contractAddress);
        const liquidityUsd = dexData?.liquidity || 0;
        const dexVolume = dexData?.volume24h || 0;

        const liquidityScore = calculateLiquidityScore(liquidityUsd, marketCap);

        // 2. Get holder distribution based on chain
        let top10Percent = 50; // Default assumption

        if (token.chain === 'solana') {
            const solanaData = await getSolanaHolderDistribution(token.contractAddress);
            if (solanaData) top10Percent = solanaData.top10Percent;
        } else if (token.chain === 'ethereum') {
            const ethData = await getEthereumHolderDistribution(token.contractAddress);
            if (ethData) top10Percent = ethData.top10Percent;
        }

        const walletDistributionScore = calculateWalletDistributionScore(top10Percent);

        // 3. Calculate pump/dump risk
        const pumpDumpRiskScore = calculatePumpDumpRiskScore(
            volumeMarketCapRatio,
            walletDistributionScore,
            liquidityScore,
            priceChange24h
        );

        return {
            liquidityScore,
            walletDistributionScore,
            pumpDumpRiskScore,
            transferVolume24h: dexVolume,
            top10HolderPercent: top10Percent
        };

    } catch (error: any) {
        logger.error(`Score calculation failed for ${token.symbol}: ${error.message}`);
        return null;
    }
}

/**
 * Populate scores for all tokens with contract addresses
 */
export async function populateTokenScores(): Promise<{ success: number; errors: string[] }> {
    const result = { success: 0, errors: [] as string[] };

    try {
        logger.info('📊 Starting token score calculation...');

        // Get tokens with contract addresses
        const tokens = await prisma.token.findMany({
            where: {
                contractAddress: { not: null },
                chain: { in: ['ethereum', 'solana'] } // Only supported chains for now
            },
            select: {
                id: true,
                symbol: true,
                chain: true,
                contractAddress: true,
                marketCap: true,
                volume24h: true,
                priceChange24h: true
            },
            orderBy: { marketCap: 'desc' }, // Process high market cap first
            take: 500 // Limit to avoid timeout
        });

        logger.info(`Processing ${tokens.length} tokens with contracts...`);

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (!token.contractAddress) continue;

            try {
                const scores = await calculateTokenScores({
                    ...token,
                    contractAddress: token.contractAddress!,
                    chain: token.chain
                });

                if (scores) {
                    await prisma.token.update({
                        where: { id: token.id },
                        data: {
                            liquidityScore: scores.liquidityScore,
                            walletDistributionScore: scores.walletDistributionScore,
                            pumpDumpRiskScore: scores.pumpDumpRiskScore,
                            transferVolume24h: scores.transferVolume24h,
                            updatedAt: new Date()
                        }
                    });
                    result.success++;
                }

                // Progress log every 50 tokens
                if ((i + 1) % 50 === 0) {
                    logger.info(`Progress: ${i + 1}/${tokens.length} tokens scored, ${result.success} updated`);
                }

                // Rate limiting delay
                await new Promise(r => setTimeout(r, 200)); // 5 req/sec

            } catch (error: any) {
                result.errors.push(`${token.symbol}: ${error.message}`);
            }
        }

        logger.info(`✅ Token scoring complete: ${result.success} updated, ${result.errors.length} errors`);

    } catch (error: any) {
        logger.error(`Token scoring failed: ${error.message}`);
        result.errors.push(error.message);
    } finally {
        await prisma.$disconnect();
    }

    return result;
}

export default {
    populateTokenScores,
    calculateTokenScores,
    fetchDexScreenerLiquidity
};
