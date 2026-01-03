import axios from 'axios';
import { logger } from './logger';
import { cache } from './cache';

interface DataSource {
  name: string;
  url: string;
  priority: number; // 1 = highest priority
  isHealthy: boolean;
  lastError?: string;
  lastCheck: Date;
  transform: (data: any) => any; // Function to normalize data format
}

interface PriceSource extends DataSource {
  getPriceUrl: (tokenId: string) => string;
}

class RedundantDataSourceManager {
  private priceSources: PriceSource[] = [
    {
      name: 'coingecko',
      url: 'https://api.coingecko.com/api/v3',
      priority: 1,
      isHealthy: true,
      lastCheck: new Date(),
      getPriceUrl: (tokenId: string) => `https://api.coingecko.com/api/v3/simple/price?ids=${tokenId}&vs_currencies=usd`,
      transform: (data: any) => ({
        price: (Object.values(data)[0] as any)?.usd || null,
        source: 'coingecko'
      })
    },
    {
      name: 'coinmarketcap',
      url: 'https://pro-api.coinmarketcap.com/v1',
      priority: 2,
      isHealthy: true,
      lastCheck: new Date(),
      getPriceUrl: (symbol: string) => `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${symbol.toUpperCase()}`,
      transform: (data: any) => ({
        price: data?.data?.[Object.keys(data.data)[0]]?.quote?.USD?.price || null,
        source: 'coinmarketcap'
      })
    },
    {
      name: 'cryptocompare',
      url: 'https://min-api.cryptocompare.com/data',
      priority: 3,
      isHealthy: true,
      lastCheck: new Date(),
      getPriceUrl: (symbol: string) => `https://min-api.cryptocompare.com/data/price?fsym=${symbol.toUpperCase()}&tsyms=USD`,
      transform: (data: any) => ({
        price: data?.USD || null,
        source: 'cryptocompare'
      })
    }
  ];

  async getReliablePrice(tokenId: string, symbol: string): Promise<{ price: number | null; source: string; confidence: 'high' | 'medium' | 'low' }> {
    const cacheKey = `reliable_price_${tokenId}_${symbol}`;
    const cached = cache.get<{ price: number; source: string; confidence: string }>(cacheKey);
    
    if (cached) {
      return cached as any;
    }

    // Sort sources by priority and health status
    const availableSources = this.priceSources
      .filter(source => source.isHealthy)
      .sort((a, b) => a.priority - b.priority);

    const results: Array<{ price: number | null; source: string }> = [];
    
    // Try each source with timeout
    for (const source of availableSources) {
      try {
        const url = source.getPriceUrl(tokenId || symbol);
        const response = await axios.get(url, {
          timeout: 3000,
          headers: source.name === 'coinmarketcap' ? {
            'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY || ''
          } : {}
        });
        
        const transformedData = source.transform(response.data);
        if (transformedData.price && transformedData.price > 0) {
          results.push(transformedData);
          this.markSourceHealthy(source.name);
          
          // If we get a result from high priority source, use it immediately
          if (source.priority === 1) {
            cache.set(cacheKey, { ...transformedData, confidence: 'high' }, 30);
            return { ...transformedData, confidence: 'high' };
          }
        }
      } catch (error: any) {
        logger.warn(`Price source ${source.name} failed: ${error.message}`);
        this.markSourceUnhealthy(source.name, error.message);
      }
    }

    // Evaluate results for consistency
    if (results.length === 0) {
      return { price: null, source: 'none', confidence: 'low' };
    }

    if (results.length === 1) {
      const result = { ...results[0], confidence: 'medium' as const };
      cache.set(cacheKey, result, 60);
      return result;
    }

    // Multiple results - check for consistency
    const prices = results.map(r => r.price).filter(p => p !== null) as number[];
    const avgPrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const maxDeviation = Math.max(...prices.map(p => Math.abs(p - avgPrice) / avgPrice));

    let confidence: 'high' | 'medium' | 'low';
    if (maxDeviation < 0.01) { // Less than 1% deviation
      confidence = 'high';
    } else if (maxDeviation < 0.05) { // Less than 5% deviation
      confidence = 'medium';
    } else {
      confidence = 'low';
      logger.warn(`Price inconsistency detected for ${symbol}: ${results.map(r => `${r.source}:${r.price}`).join(', ')}`);
    }

    const result = {
      price: avgPrice,
      source: results.map(r => r.source).join('+'),
      confidence
    };

    cache.set(cacheKey, result, confidence === 'high' ? 30 : 60);
    return result;
  }

  private markSourceHealthy(sourceName: string): void {
    const source = this.priceSources.find(s => s.name === sourceName);
    if (source) {
      source.isHealthy = true;
      source.lastCheck = new Date();
      source.lastError = undefined;
    }
  }

  private markSourceUnhealthy(sourceName: string, error: string): void {
    const source = this.priceSources.find(s => s.name === sourceName);
    if (source) {
      source.isHealthy = false;
      source.lastCheck = new Date();
      source.lastError = error;
    }
  }

  async healthCheck(): Promise<{ healthy: number; total: number; sources: any[] }> {
    const healthPromises = this.priceSources.map(async (source) => {
      try {
        await axios.get(`${source.url}/ping`, { timeout: 5000 });
        this.markSourceHealthy(source.name);
        return { name: source.name, healthy: true };
      } catch (error: any) {
        this.markSourceUnhealthy(source.name, error.message);
        return { name: source.name, healthy: false, error: error.message };
      }
    });

    const results = await Promise.allSettled(healthPromises);
    const sources = results.map((result, index) => ({
      name: this.priceSources[index].name,
      priority: this.priceSources[index].priority,
      healthy: result.status === 'fulfilled' ? result.value.healthy : false,
      error: result.status === 'fulfilled' ? result.value.error : 'Health check failed',
      lastCheck: this.priceSources[index].lastCheck
    }));

    const healthyCount = sources.filter(s => s.healthy).length;

    return {
      healthy: healthyCount,
      total: sources.length,
      sources
    };
  }

  // Auto-recovery: periodically check unhealthy sources
  startAutoRecovery(): void {
    setInterval(async () => {
      const unhealthySources = this.priceSources.filter(s => !s.isHealthy);
      for (const source of unhealthySources) {
        try {
          await axios.get(`${source.url}/ping`, { timeout: 5000 });
          this.markSourceHealthy(source.name);
          logger.info(`Data source ${source.name} recovered`);
        } catch (error: any) {
          // Source still unhealthy, update last check
          source.lastCheck = new Date();
        }
      }
    }, 2 * 60 * 1000); // Check every 2 minutes
  }
}

export const redundantDataSources = new RedundantDataSourceManager();

// Start auto-recovery on module load
redundantDataSources.startAutoRecovery();