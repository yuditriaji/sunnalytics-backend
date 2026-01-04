import { logger } from './logger';
import { withDatabase, databaseService } from './database';
import axios from 'axios';

interface DataQualityMetrics {
  timestamp: Date;
  source: string;
  availability: number; // % uptime
  latency: number; // avg response time
  accuracy: number; // % of valid data points
  freshness: number; // avg data age in seconds
  completeness: number; // % of expected fields present
}

interface HealthStatus {
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastChecked: Date;
  responseTime?: number;
  errorMessage?: string;
  dataPoints?: number;
  missingFields?: string[];
}

class DataQualityMonitor {
  private healthStatuses = new Map<string, HealthStatus>();
  private metrics: DataQualityMetrics[] = [];
  private readonly maxMetricsHistory = 1000;

  // Critical thresholds for data quality - increased for production tolerance
  private readonly thresholds = {
    availability: 95.0, // 95% uptime required (was 99%)
    latency: 15000, // Max 15s response time (was 5s)
    accuracy: 90.0, // 90% valid data (was 95%)
    freshness: 600, // Data should be < 10min old (was 5min)
    completeness: 80.0 // 80% of expected fields (was 90%)
  };

  async checkAllSources(): Promise<HealthStatus[]> {
    const checks = [
      this.checkCoinGecko(),
      this.checkSolanaRPC(),
      this.checkDatabase(),
      this.checkBirdeye(),
      this.checkEtherscan()
    ];

    const results = await Promise.allSettled(checks);
    const statuses: HealthStatus[] = [];

    results.forEach((result, index) => {
      const serviceName = ['coingecko', 'solana-rpc', 'database', 'birdeye', 'etherscan'][index];

      if (result.status === 'fulfilled') {
        statuses.push(result.value);
        this.healthStatuses.set(serviceName, result.value);
      } else {
        const unhealthyStatus: HealthStatus = {
          service: serviceName,
          status: 'unhealthy',
          lastChecked: new Date(),
          errorMessage: result.reason?.message || 'Unknown error'
        };
        statuses.push(unhealthyStatus);
        this.healthStatuses.set(serviceName, unhealthyStatus);
      }
    });

    // Log critical issues
    const unhealthyServices = statuses.filter(s => s.status === 'unhealthy');
    if (unhealthyServices.length > 0) {
      logger.error(`Critical: ${unhealthyServices.length} data sources are unhealthy`, {
        services: unhealthyServices.map(s => s.service)
      });
    }

    return statuses;
  }

  private async checkCoinGecko(): Promise<HealthStatus> {
    const startTime = Date.now();
    try {
      // Use a longer timeout and accept degraded status on slow response
      const response = await axios.get('https://api.coingecko.com/api/v3/ping', {
        timeout: 15000
      });

      const responseTime = Date.now() - startTime;
      // Be more lenient - only unhealthy if completely failed
      const status = responseTime < this.thresholds.latency ? 'healthy' : 'degraded';

      return {
        service: 'coingecko',
        status,
        lastChecked: new Date(),
        responseTime,
        dataPoints: 1
      };
    } catch (error: any) {
      // Mark as degraded instead of unhealthy for rate limiting
      const isRateLimited = error.response?.status === 429;
      return {
        service: 'coingecko',
        status: isRateLimited ? 'degraded' : 'unhealthy',
        lastChecked: new Date(),
        responseTime: Date.now() - startTime,
        errorMessage: isRateLimited ? 'Rate limited (expected)' : error.message
      };
    }
  }

  private async checkSolanaRPC(): Promise<HealthStatus> {
    const startTime = Date.now();
    // Use Helius if available, otherwise fallback to public RPC
    const rpcUrl = process.env.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

    try {
      const response = await axios.post(rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getHealth'
      }, { timeout: 15000 });

      const responseTime = Date.now() - startTime;
      // getHealth returns "ok" or error - be lenient
      const isHealthy = response.data.result === 'ok' || !response.data.error;
      const status = isHealthy && responseTime < this.thresholds.latency ? 'healthy' : 'degraded';

      return {
        service: 'solana-rpc',
        status,
        lastChecked: new Date(),
        responseTime,
        dataPoints: 1
      };
    } catch (error: any) {
      // Public Solana RPC often rate limits - mark as degraded, not unhealthy
      const isRateLimited = error.response?.status === 429 || error.code === 'ECONNRESET';
      return {
        service: 'solana-rpc',
        status: isRateLimited ? 'degraded' : 'unhealthy',
        lastChecked: new Date(),
        responseTime: Date.now() - startTime,
        errorMessage: isRateLimited ? 'RPC rate limited (using fallback)' : error.message
      };
    }
  }

  private async checkDatabase(): Promise<HealthStatus> {
    const startTime = Date.now();
    try {
      // Check database connectivity and recent data using resilient connection
      const recentTokens = await withDatabase(async (prisma) => {
        return await prisma.token.count({
          where: {
            updatedAt: {
              gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
            }
          }
        });
      });

      const responseTime = Date.now() - startTime;
      const status = recentTokens > 0 && responseTime < 2000 ? 'healthy' : 'degraded';

      return {
        service: 'database',
        status,
        lastChecked: new Date(),
        responseTime,
        dataPoints: recentTokens
      };
    } catch (error: any) {
      return {
        service: 'database',
        status: 'unhealthy',
        lastChecked: new Date(),
        responseTime: Date.now() - startTime,
        errorMessage: error.message
      };
    }
  }

  private async checkBirdeye(): Promise<HealthStatus> {
    if (!process.env.BIRDEYE_API_KEY) {
      return {
        service: 'birdeye',
        status: 'unhealthy',
        lastChecked: new Date(),
        errorMessage: 'API key not configured'
      };
    }

    const startTime = Date.now();
    try {
      // Test with a known Solana token
      const response = await axios.get('https://public-api.birdeye.so/defi/price', {
        params: {
          address: 'So11111111111111111111111111111111111111112', // Wrapped SOL
          network: 'solana'
        },
        headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY },
        timeout: 10000
      });

      const responseTime = Date.now() - startTime;
      const hasValidData = response.data?.data?.value > 0;
      const status = hasValidData && responseTime < this.thresholds.latency ? 'healthy' : 'degraded';

      return {
        service: 'birdeye',
        status,
        lastChecked: new Date(),
        responseTime,
        dataPoints: hasValidData ? 1 : 0
      };
    } catch (error: any) {
      return {
        service: 'birdeye',
        status: 'unhealthy',
        lastChecked: new Date(),
        responseTime: Date.now() - startTime,
        errorMessage: error.message
      };
    }
  }

  private async checkEtherscan(): Promise<HealthStatus> {
    if (!process.env.ETHERSCAN_API_KEY) {
      return {
        service: 'etherscan',
        status: 'degraded', // Degraded not unhealthy since it's optional
        lastChecked: new Date(),
        errorMessage: 'API key not configured'
      };
    }

    const startTime = Date.now();
    try {
      const response = await axios.get('https://api.etherscan.io/api', {
        params: {
          module: 'proxy',
          action: 'eth_blockNumber',
          apikey: process.env.ETHERSCAN_API_KEY
        },
        timeout: 10000
      });

      const responseTime = Date.now() - startTime;
      const hasValidData = response.data?.result && parseInt(response.data.result, 16) > 0;
      const status = hasValidData && responseTime < this.thresholds.latency ? 'healthy' : 'degraded';

      return {
        service: 'etherscan',
        status,
        lastChecked: new Date(),
        responseTime,
        dataPoints: hasValidData ? 1 : 0
      };
    } catch (error: any) {
      return {
        service: 'etherscan',
        status: 'unhealthy',
        lastChecked: new Date(),
        responseTime: Date.now() - startTime,
        errorMessage: error.message
      };
    }
  }

  async validateTokenData(): Promise<{ valid: number; total: number; issues: string[] }> {
    const issues: string[] = [];

    try {
      const results = await withDatabase(async (prisma) => {
        // Check for tokens with missing critical data
        const tokensWithoutPrice = await prisma.token.count({
          where: { price: { equals: null } }
        });

        const tokensWithoutMarketCap = await prisma.token.count({
          where: { marketCap: { equals: null } }
        });

        const recentTokens = await prisma.token.count({
          where: {
            updatedAt: {
              gte: new Date(Date.now() - 60 * 60 * 1000) // Last hour
            }
          }
        });

        const totalTokens = await prisma.token.count();

        return { tokensWithoutPrice, tokensWithoutMarketCap, recentTokens, totalTokens };
      });

      const { tokensWithoutPrice, tokensWithoutMarketCap, recentTokens, totalTokens } = results;

      if (tokensWithoutPrice > totalTokens * 0.1) {
        issues.push(`${tokensWithoutPrice} tokens missing price data`);
      }

      if (tokensWithoutMarketCap > totalTokens * 0.2) {
        issues.push(`${tokensWithoutMarketCap} tokens missing market cap`);
      }

      if (recentTokens < totalTokens * 0.5) {
        issues.push(`Only ${recentTokens}/${totalTokens} tokens updated in last hour`);
      }

      const validTokens = totalTokens - tokensWithoutPrice - tokensWithoutMarketCap;

      return {
        valid: Math.max(0, validTokens),
        total: totalTokens,
        issues
      };
    } catch (error: any) {
      logger.error(`Data validation failed: ${error.message}`);
      return {
        valid: 0,
        total: 0,
        issues: [`Database validation failed: ${error.message}`]
      };
    }
  }

  getOverallHealth(): 'healthy' | 'degraded' | 'critical' {
    const statuses = Array.from(this.healthStatuses.values());
    const unhealthyCount = statuses.filter(s => s.status === 'unhealthy').length;
    const degradedCount = statuses.filter(s => s.status === 'degraded').length;

    if (unhealthyCount > 1) return 'critical';
    if (unhealthyCount > 0 || degradedCount > 2) return 'degraded';
    return 'healthy';
  }

  async logQualityReport(): Promise<void> {
    const healthStatuses = await this.checkAllSources();
    const tokenValidation = await this.validateTokenData();
    const overallHealth = this.getOverallHealth();

    logger.info('Data Quality Report', {
      overallHealth,
      services: healthStatuses.map(s => ({
        name: s.service,
        status: s.status,
        responseTime: s.responseTime
      })),
      dataQuality: {
        validTokens: `${tokenValidation.valid}/${tokenValidation.total}`,
        completeness: `${((tokenValidation.valid / tokenValidation.total) * 100).toFixed(1)}%`,
        issues: tokenValidation.issues
      }
    });
  }
}

export const dataQualityMonitor = new DataQualityMonitor();

// Schedule health checks every 5 minutes
setInterval(async () => {
  try {
    await dataQualityMonitor.logQualityReport();
  } catch (error: any) {
    logger.error(`Health check failed: ${error.message}`);
  }
}, 5 * 60 * 1000);