"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateTokenMetrics = calculateTokenMetrics;
function calculateTokenMetrics(token) {
    const volumeMarketCapRatio = token.marketCap > 0 ? token.volume24h / token.marketCap : 0;
    const circulatingSupplyPercentage = (token.circulatingSupply && token.totalSupply && token.totalSupply > 0)
        ? (token.circulatingSupply / token.totalSupply) * 100
        : 0;
    const potentialMultiplier = (token.targetMarketCap && token.marketCap > 0)
        ? token.targetMarketCap / token.marketCap
        : 0;
    return {
        marketCap: token.marketCap,
        fullyDilutedValuation: token.price * (token.totalSupply || 0),
        volumeMarketCapRatio,
        circulatingSupplyPercentage,
        isVolumeHealthy: volumeMarketCapRatio > 0.1,
        isCirculatingSupplyGood: circulatingSupplyPercentage > 50,
        potentialMultiplier
    };
}
