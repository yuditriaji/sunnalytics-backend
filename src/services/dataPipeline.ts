import { PrismaClient } from '@prisma/client';
import { logger } from './logger';
import { rateLimiter } from './rateLimiter';
import { DataConsistencyValidator, DataSanitizer } from '../utils/enhancedValidation';
import { fetchMarketData, fetchExchangeTokens } from '../api/coingecko';
import { fetchBitqueryTokens } from '../api/bitquery';
import { fetchOnChainData } from '../api/onchain';
import { calculateTokenMetrics } from '../utils/tokenAnalytics';
import axios from 'axios';

// Cast to any to avoid type conflicts during schema migration
const prisma = new PrismaClient() as any;

interface PipelineStats {
  startTime: Date;
  endTime?: Date;
  totalProcessed: number;
  successfulUpserts: number;
  failures: number;
  skipped: number;
  dataQualityIssues: number;
  phases: {
    tokenHeaders: { processed: number; success: number; errors: string[] };
    exchangeData: { processed: number; success: number; errors: string[] };
    marketData: { processed: number; success: number; errors: string[] };
    onchainData: { processed: number; success: number; errors: string[] };
    tokenDetails: { processed: number; success: number; errors: string[] };
  };
}

interface DataQualityReport {
  totalTokens: number;
  validTokens: number;
  missingPrices: number;
  missingMarketCaps: number;
  missingContractAddresses: number;
  dataConsistencyIssues: string[];
  qualityScore: number; // 0-100
}

class ComprehensiveDataPipeline {
  private stats: PipelineStats = {
    startTime: new Date(),
    totalProcessed: 0,
    successfulUpserts: 0,
    failures: 0,
    skipped: 0,
    dataQualityIssues: 0,
    phases: {
      tokenHeaders: { processed: 0, success: 0, errors: [] },
      exchangeData: { processed: 0, success: 0, errors: [] },
      marketData: { processed: 0, success: 0, errors: [] },
      onchainData: { processed: 0, success: 0, errors: [] },
      tokenDetails: { processed: 0, success: 0, errors: [] }
    }
  };

  async runComprehensivePipeline(): Promise<PipelineStats> {
    logger.info('🚀 Starting comprehensive data pipeline for 100% data quality');
    this.stats = {
      startTime: new Date(),
      totalProcessed: 0,
      successfulUpserts: 0,
      failures: 0,
      skipped: 0,
      dataQualityIssues: 0,
      phases: {
        tokenHeaders: { processed: 0, success: 0, errors: [] },
        exchangeData: { processed: 0, success: 0, errors: [] },
        marketData: { processed: 0, success: 0, errors: [] },
        onchainData: { processed: 0, success: 0, errors: [] },
        tokenDetails: { processed: 0, success: 0, errors: [] }
      }
    };

    try {
      // Phase 1: Populate Token Headers (if not already done)
      await this.ensureTokenHeaders();

      // Phase 2: Populate Exchange Token Mappings
      await this.populateExchangeTokens();

      // Phase 3: Fetch and Process Market Data (Rate-limited)
      await this.processMarketDataWithRateLimit();

      // Phase 4: Fetch Blockchain Data (Parallel with rate limiting)
      await this.processBlockchainData();

      // Phase 5: Populate Token Details with On-chain Data
      await this.populateTokenDetails();

      // Phase 6: Update Analytics Scores
      await this.updateAnalyticsScores();

      // Phase 7: Data Quality Validation & Reporting
      const qualityReport = await this.validateDataQuality();

      this.stats.endTime = new Date();
      const duration = this.stats.endTime.getTime() - this.stats.startTime.getTime();

      logger.info('✅ Data pipeline completed successfully', {
        duration: `${Math.round(duration / 1000)}s`,
        processed: this.stats.totalProcessed,
        success: this.stats.successfulUpserts,
        failures: this.stats.failures,
        qualityScore: `${qualityReport.qualityScore.toFixed(1)}%`
      });

      return this.stats;

    } catch (error: any) {
      logger.error('❌ Data pipeline failed', { error: error.message });
      throw error;
    } finally {
      await prisma.$disconnect();
    }
  }

  private async ensureTokenHeaders(): Promise<void> {
    logger.info('📊 Phase 1: Ensuring token headers are populated');

    const headerCount = await prisma.tokenHeader.count();
    if (headerCount < 1000) {
      logger.info('Token headers need population, fetching from CoinGecko...');

      try {
        await rateLimiter.executeWithRateLimit('coingecko', async () => {
          const response = await axios.get('https://api.coingecko.com/api/v3/coins/list', {
            params: { include_platform: true },
            timeout: 30000
          });

          const tokens = response.data;
          this.stats.phases.tokenHeaders.processed = tokens.length;

          const batchSize = 100;
          for (let i = 0; i < tokens.length; i += batchSize) {
            const batch = tokens.slice(i, i + batchSize);

            try {
              await prisma.$transaction(
                batch.map((token: any) =>
                  prisma.tokenHeader.upsert({
                    where: { id: token.id },
                    update: {
                      symbol: token.symbol.toLowerCase(),
                      name: token.name,
                      platforms: token.platforms || {},
                      updatedAt: new Date()
                    },
                    create: {
                      id: token.id,
                      symbol: token.symbol.toLowerCase(),
                      name: token.name,
                      platforms: token.platforms || {},
                      exchange: null,
                      createdAt: new Date(),
                      updatedAt: new Date()
                    }
                  })
                )
              );

              this.stats.phases.tokenHeaders.success += batch.length;

            } catch (error: any) {
              logger.error(`Token header batch failed: ${error.message}`);
              this.stats.phases.tokenHeaders.errors.push(`Batch ${i}: ${error.message}`);
            }
          }
        }, 'high');

      } catch (error: any) {
        logger.error(`Token header population failed: ${error.message}`);
        this.stats.phases.tokenHeaders.errors.push(error.message);
      }
    }

    logger.info(`✅ Token headers: ${this.stats.phases.tokenHeaders.success} processed`);
  }

  private async populateExchangeTokens(): Promise<void> {
    logger.info('🏦 Phase 2: Populating exchange token mappings');

    const exchanges = ['binance', 'bybit_spot', 'mexc', 'huobi', 'gate', 'kucoin', 'okx'];

    for (const exchange of exchanges) {
      try {
        await rateLimiter.executeWithRateLimit('coingecko', async () => {
          let page = 1;
          let hasMore = true;

          while (hasMore && page <= 5) { // Limit pages to prevent excessive requests
            try {
              const response = await axios.get(`https://api.coingecko.com/api/v3/exchanges/${exchange}/tickers`, {
                params: { per_page: 100, page },
                timeout: 15000
              });

              const tickers = response.data.tickers || [];
              if (tickers.length === 0 || tickers.length < 100) hasMore = false;

              const exchangeTokens = tickers
                .filter((ticker: any) => ticker.coin_id && ticker.target === 'USDT')
                .map((ticker: any) => ({
                  coinId: ticker.coin_id,
                  symbol: ticker.base.toLowerCase(),
                  exchange: exchange === 'huobi' ? 'htx' : exchange
                }));

              // Batch update token headers with exchange info
              for (const token of exchangeTokens) {
                try {
                  await prisma.tokenHeader.upsert({
                    where: { id: token.coinId },
                    update: {
                      exchange: token.exchange,
                      updatedAt: new Date()
                    },
                    create: {
                      id: token.coinId,
                      symbol: token.symbol,
                      name: token.symbol.toUpperCase(),
                      platforms: {},
                      exchange: token.exchange,
                      createdAt: new Date(),
                      updatedAt: new Date()
                    }
                  });

                  this.stats.phases.exchangeData.success++;
                } catch (error: any) {
                  this.stats.phases.exchangeData.errors.push(`${token.coinId}: ${error.message}`);
                }
              }

              this.stats.phases.exchangeData.processed += tickers.length;
              page++;

            } catch (error: any) {
              logger.warn(`Exchange ${exchange} page ${page} failed: ${error.message}`);
              break;
            }
          }
        }, 'medium');

      } catch (error: any) {
        logger.warn(`Exchange ${exchange} failed completely: ${error.message}`);
        this.stats.phases.exchangeData.errors.push(`${exchange}: ${error.message}`);
      }
    }

    logger.info(`✅ Exchange data: ${this.stats.phases.exchangeData.success} tokens mapped`);
  }

  private async processMarketDataWithRateLimit(): Promise<void> {
    logger.info('💰 Phase 3: Processing market data with intelligent rate limiting');

    // Get tokens with exchange mappings
    const tokensWithExchanges = await prisma.tokenHeader.findMany({
      where: { exchange: { not: null } },
      select: { id: true, symbol: true, platforms: true, exchange: true }
    });

    logger.info(`Found ${tokensWithExchanges.length} tokens with exchange mappings`);

    // Process in smaller batches to respect rate limits
    const batchSize = 10;
    for (let i = 0; i < tokensWithExchanges.length; i += batchSize) {
      const batch = tokensWithExchanges.slice(i, i + batchSize);

      try {
        await rateLimiter.executeWithRateLimit('coingecko', async () => {
          // Fetch market data for this batch
          const ids = batch.map((t: any) => t.id).join(',');
          const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: {
              ids,
              vs_currencies: 'usd',
              include_market_cap: true,
              include_24hr_vol: true,
              include_24hr_change: true
            },
            timeout: 15000
          });

          const marketData = response.data;

          // Process each token in the batch
          for (const tokenHeader of batch) {
            const data = marketData[tokenHeader.id];
            if (!data) continue;

            try {
              // Sanitize and validate data
              const sanitizedData = DataSanitizer.sanitizeTokenData({
                name: tokenHeader.symbol.toUpperCase(),
                symbol: tokenHeader.symbol,
                price: data.usd,
                marketCap: data.usd_market_cap,
                volume24h: data.usd_24h_vol,
                priceChange24h: data.usd_24h_change,
                contractAddress: this.extractContractAddress(tokenHeader.platforms),
                platform: this.extractPlatform(tokenHeader.platforms),
                exchange: tokenHeader.exchange
              });

              // Validate data consistency
              const validation = DataConsistencyValidator.validateTokenDataConsistency(sanitizedData);
              if (!validation.isValid) {
                logger.warn(`Data quality issues for ${tokenHeader.symbol}:`, validation.issues);
                this.stats.dataQualityIssues++;
              }

              // Determine category
              const category = this.determineTokenCategory(tokenHeader.symbol, sanitizedData);

              // Upsert to Token table
              const token = await prisma.token.upsert({
                where: { symbol: tokenHeader.symbol },
                update: {
                  name: sanitizedData.name,
                  category,
                  price: sanitizedData.price,
                  marketCap: sanitizedData.marketCap,
                  volume24h: sanitizedData.volume24h,
                  priceChange24h: sanitizedData.priceChange24h,
                  contractAddress: sanitizedData.contractAddress,
                  platform: sanitizedData.platform,
                  exchange: sanitizedData.exchange,
                  updatedAt: new Date()
                },
                create: {
                  name: sanitizedData.name,
                  symbol: tokenHeader.symbol,
                  category,
                  price: sanitizedData.price,
                  marketCap: sanitizedData.marketCap,
                  volume24h: sanitizedData.volume24h,
                  priceChange24h: sanitizedData.priceChange24h,
                  contractAddress: sanitizedData.contractAddress,
                  platform: sanitizedData.platform,
                  exchange: sanitizedData.exchange,
                  createdAt: new Date(),
                  updatedAt: new Date()
                }
              });

              // Create history record
              await prisma.tokenHistory.create({
                data: {
                  tokenId: token.id,
                  price: sanitizedData.price,
                  marketCap: sanitizedData.marketCap,
                  volume24h: sanitizedData.volume24h,
                  timestamp: new Date()
                }
              });

              // Create/update exchange records
              if (sanitizedData.exchange) {
                const exchanges = sanitizedData.exchange.split(',');
                for (const ex of exchanges) {
                  await prisma.tokenExchange.upsert({
                    where: {
                      tokenId_exchange: { tokenId: token.id, exchange: ex.trim() }
                    },
                    update: {
                      symbol: tokenHeader.symbol,
                      lastPrice: sanitizedData.price,
                      volume: sanitizedData.volume24h,
                      updatedAt: new Date()
                    },
                    create: {
                      tokenId: token.id,
                      exchange: ex.trim(),
                      symbol: tokenHeader.symbol,
                      lastPrice: sanitizedData.price,
                      volume: sanitizedData.volume24h,
                      createdAt: new Date(),
                      updatedAt: new Date()
                    }
                  });
                }
              }

              this.stats.phases.marketData.success++;
              this.stats.successfulUpserts++;

            } catch (error: any) {
              logger.error(`Token processing failed for ${tokenHeader.symbol}: ${error.message}`);
              this.stats.phases.marketData.errors.push(`${tokenHeader.symbol}: ${error.message}`);
              this.stats.failures++;
            }
          }

          this.stats.phases.marketData.processed += batch.length;
        }, 'high');

      } catch (error: any) {
        logger.error(`Market data batch failed: ${error.message}`);
        this.stats.phases.marketData.errors.push(`Batch ${i}: ${error.message}`);
      }
    }

    logger.info(`✅ Market data: ${this.stats.phases.marketData.success} tokens processed`);
  }

  private async processBlockchainData(): Promise<void> {
    logger.info('⛓️ Phase 4: Processing blockchain data');

    // Process Solana data
    try {
      await rateLimiter.executeWithRateLimit('solana', async () => {
        const solanaTokens = await fetchBitqueryTokens();

        for (const token of solanaTokens) {
          try {
            // Find existing token or create new one
            const existingToken = await prisma.token.findUnique({
              where: { symbol: token.symbol.toLowerCase() }
            });

            if (existingToken) {
              // Update with Solana data
              await prisma.token.update({
                where: { symbol: token.symbol.toLowerCase() },
                data: {
                  transferVolume24h: token.transferAmount,
                  contractAddress: token.address,
                  platform: 'solana',
                  updatedAt: new Date()
                }
              });
            }

            this.stats.phases.onchainData.success++;
          } catch (error: any) {
            this.stats.phases.onchainData.errors.push(`${token.symbol}: ${error.message}`);
          }
        }

        this.stats.phases.onchainData.processed += solanaTokens.length;
      }, 'medium');

    } catch (error: any) {
      logger.warn(`Solana data processing failed: ${error.message}`);
      this.stats.phases.onchainData.errors.push(`Solana: ${error.message}`);
    }

    logger.info(`✅ Blockchain data: ${this.stats.phases.onchainData.success} tokens processed`);
  }

  private async populateTokenDetails(): Promise<void> {
    logger.info('🔍 Phase 5: Populating token details with on-chain data');

    const tokensWithContracts = await prisma.token.findMany({
      where: {
        AND: [
          { contractAddress: { not: null } },
          { platform: { not: null } }
        ]
      },
      select: { id: true, symbol: true, contractAddress: true, platform: true },
      take: 100 // Limit for rate limiting
    });

    for (const token of tokensWithContracts) {
      try {
        if (!token.contractAddress || !token.platform) continue;

        // Find corresponding header
        const header = await prisma.tokenHeader.findFirst({
          where: { symbol: token.symbol },
          select: { id: true }
        });

        if (!header) continue;

        // Fetch on-chain data with rate limiting
        const onChainData = await fetchOnChainData(
          header.id,
          token.symbol,
          token.contractAddress,
          token.platform
        );

        if (onChainData) {
          // Upsert TokenDetail
          await prisma.tokenDetail.upsert({
            where: { id: header.id },
            update: {
              symbol: token.symbol,
              platform: token.platform,
              contractAddress: token.contractAddress,
              walletDistributionScore: onChainData.walletDistributionScore,
              poolLiquidity: onChainData.poolLiquidity,
              txActivityScore: onChainData.txActivityScore,
              transferVolume24h: onChainData.transferVolume24h,
              updatedAt: new Date()
            },
            create: {
              id: header.id,
              symbol: token.symbol,
              platform: token.platform,
              contractAddress: token.contractAddress,
              walletDistributionScore: onChainData.walletDistributionScore,
              poolLiquidity: onChainData.poolLiquidity,
              txActivityScore: onChainData.txActivityScore,
              transferVolume24h: onChainData.transferVolume24h,
              createdAt: new Date(),
              updatedAt: new Date()
            }
          });

          // Update Token with analytics
          const metrics = await calculateTokenMetrics({
            coingeckoId: header.id,
            contractAddress: token.contractAddress,
            platform: token.platform
          });

          await prisma.token.update({
            where: { id: token.id },
            data: {
              walletDistributionScore: onChainData.walletDistributionScore,
              liquidityScore: metrics.volumeMarketCapRatio > 0 ?
                Math.min(metrics.volumeMarketCapRatio * 100, 100) : null,
              pumpDumpRiskScore: metrics.pumpDumpRiskScore || null,
              updatedAt: new Date()
            }
          });

          this.stats.phases.tokenDetails.success++;
        }

        this.stats.phases.tokenDetails.processed++;

      } catch (error: any) {
        logger.error(`Token detail processing failed for ${token.symbol}: ${error.message}`);
        this.stats.phases.tokenDetails.errors.push(`${token.symbol}: ${error.message}`);
      }
    }

    logger.info(`✅ Token details: ${this.stats.phases.tokenDetails.success} processed`);
  }

  private async updateAnalyticsScores(): Promise<void> {
    logger.info('📈 Phase 6: Updating analytics scores');

    try {
      // Update liquidity scores
      await prisma.$executeRaw`
        UPDATE "Token"
        SET "liquidityScore" = LEAST(GREATEST(
          COALESCE(
            ((COALESCE("volume24h", 0) / NULLIF("marketCap", 0) * 0.7) +
             (COALESCE("transferVolume24h", 0) / NULLIF("marketCap", 0) * 0.3)) * 100,
            0
          ),
          0
        ), 100)
        WHERE "marketCap" IS NOT NULL AND "marketCap" > 0;
      `;

      // Update pump-dump risk scores
      await prisma.$executeRaw`
        WITH PriceChanges AS (
          SELECT
            "tokenId",
            "timestamp",
            "volume24h",
            "price",
            (("price" - LAG("price") OVER (PARTITION BY "tokenId" ORDER BY "timestamp"))
              / NULLIF(LAG("price") OVER (PARTITION BY "tokenId" ORDER BY "timestamp"), 0)) AS price_change_ratio
          FROM "TokenHistory"
          WHERE "timestamp" >= NOW() - INTERVAL '7 days'
        ),
        HistoricalData AS (
          SELECT
            "tokenId",
            AVG("volume24h") AS avg_volume,
            STDDEV_POP(COALESCE(price_change_ratio, 0)) AS price_volatility
          FROM PriceChanges
          GROUP BY "tokenId"
          HAVING COUNT(*) >= 3
        )
        UPDATE "Token" t
        SET "pumpDumpRiskScore" = LEAST(GREATEST(
          COALESCE(
            (
              (COALESCE(t."volume24h", 0) - COALESCE(h.avg_volume, 0)) / NULLIF(h.avg_volume, 0) * 0.5 +
              COALESCE(h.price_volatility, 0) * 0.5
            ) * 100,
            0
          ),
          0
        ), 100)
        FROM HistoricalData h
        WHERE t.id = h."tokenId"
        AND t."marketCap" IS NOT NULL AND t."marketCap" > 0
        AND h.avg_volume IS NOT NULL AND h.avg_volume > 0;
      `;

      logger.info('✅ Analytics scores updated successfully');

    } catch (error: any) {
      logger.error(`Analytics score update failed: ${error.message}`);
      throw error;
    }
  }

  private async validateDataQuality(): Promise<DataQualityReport> {
    logger.info('🔍 Phase 7: Validating data quality');

    const totalTokens = await prisma.token.count();
    const tokensWithPrices = await prisma.token.count({ where: { price: { not: null } } });
    const tokensWithMarketCaps = await prisma.token.count({ where: { marketCap: { not: null } } });
    const tokensWithContracts = await prisma.token.count({ where: { contractAddress: { not: null } } });

    const validTokens = await prisma.token.count({
      where: {
        AND: [
          { price: { not: null } },
          { marketCap: { not: null } },
          { price: { gt: 0 } },
          { marketCap: { gt: 1000 } }
        ]
      }
    });

    const report: DataQualityReport = {
      totalTokens,
      validTokens,
      missingPrices: totalTokens - tokensWithPrices,
      missingMarketCaps: totalTokens - tokensWithMarketCaps,
      missingContractAddresses: totalTokens - tokensWithContracts,
      dataConsistencyIssues: [],
      qualityScore: totalTokens > 0 ? (validTokens / totalTokens) * 100 : 0
    };

    logger.info('📊 Data Quality Report:', {
      totalTokens: report.totalTokens,
      validTokens: report.validTokens,
      qualityScore: `${report.qualityScore.toFixed(1)}%`,
      missingPrices: report.missingPrices,
      missingMarketCaps: report.missingMarketCaps
    });

    return report;
  }

  // Helper methods
  private extractContractAddress(platforms: any): string | undefined {
    if (!platforms || typeof platforms !== 'object') return undefined;

    const supportedPlatforms = ['solana', 'ethereum', 'polygon', 'arbitrum', 'optimism', 'avalanche', 'bnb'];
    for (const platform of supportedPlatforms) {
      if (platforms[platform]) return platforms[platform];
    }
    return undefined;
  }

  private extractPlatform(platforms: any): string | undefined {
    if (!platforms || typeof platforms !== 'object') return undefined;

    const supportedPlatforms = ['solana', 'ethereum', 'polygon', 'arbitrum', 'optimism', 'avalanche', 'bnb'];
    return supportedPlatforms.find(p => platforms[p]);
  }

  private determineTokenCategory(symbol: string, data: any): string {
    const memecoins = ['doge', 'shib', 'pepe', 'floki', 'bonk', 'wif'];
    const defiTokens = ['uni', 'aave', 'comp', 'sushi', 'cake', 'crv'];

    const symbolLower = symbol.toLowerCase();

    if (memecoins.includes(symbolLower)) return 'memecoin';
    if (defiTokens.includes(symbolLower)) return 'defi';

    return 'altcoin';
  }

  getStats(): PipelineStats {
    return this.stats;
  }

  async getQualityReport(): Promise<DataQualityReport> {
    return this.validateDataQuality();
  }
}

export const dataPipeline = new ComprehensiveDataPipeline();