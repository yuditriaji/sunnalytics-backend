import { cache } from './cache';
import { logger } from './logger';

interface CacheConfig {
  ttl: number;
  refreshThreshold: number; // When to trigger background refresh (as % of TTL)
  maxStale: number; // How long to serve stale data while refreshing
}

interface DataSource {
  key: string;
  fetcher: () => Promise<any>;
  validator: (data: any) => boolean;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

class EnhancedCache {
  private refreshingKeys = new Set<string>();
  
  // Standardized TTL configurations for data consistency
  private readonly configs: Record<string, CacheConfig> = {
    'market_data': { ttl: 60, refreshThreshold: 0.8, maxStale: 300 }, // 1min with 5min stale
    'price_data': { ttl: 30, refreshThreshold: 0.9, maxStale: 120 }, // 30s with 2min stale  
    'onchain_data': { ttl: 300, refreshThreshold: 0.8, maxStale: 900 }, // 5min with 15min stale
    'token_list': { ttl: 3600, refreshThreshold: 0.9, maxStale: 7200 }, // 1hr with 2hr stale
    'analytics': { ttl: 180, refreshThreshold: 0.8, maxStale: 600 }, // 3min with 10min stale
  };

  async getWithFreshness<T>(
    key: string, 
    category: keyof typeof this.configs,
    dataSource: DataSource
  ): Promise<{ data: T | null; isFresh: boolean; age: number }> {
    const config = this.configs[category];
    const cached = this.getCachedWithMeta<T>(key);
    
    if (!cached) {
      // No cached data, fetch fresh
      const freshData = await this.fetchAndValidate<T>(dataSource);
      if (freshData) {
        cache.set(key, freshData, config.ttl);
        return { data: freshData, isFresh: true, age: 0 };
      }
      return { data: null, isFresh: false, age: Infinity };
    }

    const { data, age } = cached;
    const refreshThresholdTime = config.ttl * config.refreshThreshold;
    
    // Data is fresh enough
    if (age < refreshThresholdTime) {
      return { data, isFresh: true, age };
    }

    // Data needs refresh but still within stale threshold
    if (age < config.maxStale) {
      // Trigger background refresh if not already refreshing
      if (!this.refreshingKeys.has(key)) {
        this.backgroundRefresh(key, config, dataSource).catch(err => 
          logger.error(`Background refresh failed for ${key}: ${err.message}`)
        );
      }
      return { data, isFresh: false, age };
    }

    // Data too stale, force refresh
    const freshData = await this.fetchAndValidate<T>(dataSource);
    if (freshData) {
      cache.set(key, freshData, config.ttl);
      return { data: freshData, isFresh: true, age: 0 };
    }

    // Fresh fetch failed, return stale data with warning
    logger.warn(`Serving stale data for ${key}, age: ${age}s, max: ${config.maxStale}s`);
    return { data, isFresh: false, age };
  }

  private getCachedWithMeta<T>(key: string): { data: T; age: number } | null {
    const cached = (cache as any).store.get(key);
    if (!cached || Date.now() > cached.expiry) {
      return null;
    }
    const age = (Date.now() - (cached.expiry - (cached.expiry - Date.now()))) / 1000;
    return { data: cached.data, age };
  }

  private async fetchAndValidate<T>(dataSource: DataSource): Promise<T | null> {
    try {
      const data = await dataSource.fetcher();
      if (!dataSource.validator(data)) {
        logger.error(`Data validation failed for ${dataSource.key}`);
        return null;
      }
      return data;
    } catch (error: any) {
      logger.error(`Data fetch failed for ${dataSource.key}: ${error.message}`);
      return null;
    }
  }

  private async backgroundRefresh(
    key: string, 
    config: CacheConfig, 
    dataSource: DataSource
  ): Promise<void> {
    this.refreshingKeys.add(key);
    try {
      const freshData = await this.fetchAndValidate(dataSource);
      if (freshData) {
        cache.set(key, freshData, config.ttl);
        logger.info(`Background refresh successful for ${key}`);
      }
    } finally {
      this.refreshingKeys.delete(key);
    }
  }
}

export const enhancedCache = new EnhancedCache();

// Data validation functions
export const validators = {
  priceData: (data: any) => typeof data?.price === 'number' && data.price > 0,
  marketData: (data: any) => Array.isArray(data) && data.length > 0,
  onchainData: (data: any) => data && typeof data === 'object',
  tokenList: (data: any) => Array.isArray(data) && data.every((t: any) => t.symbol && t.id)
};