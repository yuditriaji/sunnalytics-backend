import { logger } from './logger';

interface RateLimitConfig {
  maxRequestsPerMinute: number;
  maxRequestsPerHour: number;
  baseDelay: number; // Base delay in ms
  maxDelay: number; // Max delay in ms
  backoffMultiplier: number;
  circuitBreakerThreshold: number; // Failures before circuit opens
  circuitBreakerTimeout: number; // Time to wait before retry
}

interface ApiEndpoint {
  name: string;
  baseUrl: string;
  config: RateLimitConfig;
  requestTimes: number[];
  failureCount: number;
  isCircuitOpen: boolean;
  lastFailureTime: number;
  consecutiveFailures: number;
}

class SmartRateLimiter {
  private endpoints: Map<string, ApiEndpoint> = new Map();

  constructor() {
    this.initializeEndpoints();
  }

  private initializeEndpoints() {
    // CoinGecko configuration - optimized for free tier (30 req/min with pacing)
    this.endpoints.set('coingecko', {
      name: 'CoinGecko',
      baseUrl: 'https://api.coingecko.com/api/v3',
      config: {
        maxRequestsPerMinute: 30, // CoinGecko free tier allows ~30/min
        maxRequestsPerHour: 1000,
        baseDelay: 2000, // 2 seconds base delay (was 6s)
        maxDelay: 30000, // Max 30 second delay (was 60s)
        backoffMultiplier: 1.5,
        circuitBreakerThreshold: 5, // More tolerance (was 3)
        circuitBreakerTimeout: 120000 // 2 minutes (was 5)
      },
      requestTimes: [],
      failureCount: 0,
      isCircuitOpen: false,
      lastFailureTime: 0,
      consecutiveFailures: 0
    });

    // Bitquery/Solana RPC configuration
    // Helius allows 100+ req/sec, public RPC is ~10-15/min
    const hasHelius = !!process.env.HELIUS_API_KEY;
    this.endpoints.set('solana', {
      name: 'Solana RPC',
      baseUrl: hasHelius
        ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
        : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'),
      config: {
        maxRequestsPerMinute: hasHelius ? 300 : 10, // Helius is much faster
        maxRequestsPerHour: hasHelius ? 10000 : 300,
        baseDelay: hasHelius ? 200 : 6000, // 0.2s for Helius, 6s for public
        maxDelay: hasHelius ? 5000 : 60000,
        backoffMultiplier: 1.3,
        circuitBreakerThreshold: 5,
        circuitBreakerTimeout: 180000 // 3 minutes
      },
      requestTimes: [],
      failureCount: 0,
      isCircuitOpen: false,
      lastFailureTime: 0,
      consecutiveFailures: 0
    });

    // Birdeye API configuration
    this.endpoints.set('birdeye', {
      name: 'Birdeye',
      baseUrl: 'https://public-api.birdeye.so',
      config: {
        maxRequestsPerMinute: 60,
        maxRequestsPerHour: 2000,
        baseDelay: 1000, // 1 second
        maxDelay: 15000,
        backoffMultiplier: 1.2,
        circuitBreakerThreshold: 4,
        circuitBreakerTimeout: 120000 // 2 minutes
      },
      requestTimes: [],
      failureCount: 0,
      isCircuitOpen: false,
      lastFailureTime: 0,
      consecutiveFailures: 0
    });

    // Etherscan configuration
    this.endpoints.set('etherscan', {
      name: 'Etherscan',
      baseUrl: 'https://api.etherscan.io/api',
      config: {
        maxRequestsPerMinute: 100, // With API key
        maxRequestsPerHour: 5000,
        baseDelay: 600, // 0.6 seconds
        maxDelay: 10000,
        backoffMultiplier: 1.2,
        circuitBreakerThreshold: 3,
        circuitBreakerTimeout: 60000 // 1 minute
      },
      requestTimes: [],
      failureCount: 0,
      isCircuitOpen: false,
      lastFailureTime: 0,
      consecutiveFailures: 0
    });
  }

  async executeWithRateLimit<T>(
    endpointName: string,
    operation: () => Promise<T>,
    priority: 'high' | 'medium' | 'low' = 'medium'
  ): Promise<T> {
    const endpoint = this.endpoints.get(endpointName);
    if (!endpoint) {
      throw new Error(`Unknown endpoint: ${endpointName}`);
    }

    // Check circuit breaker
    if (this.isCircuitBreakerOpen(endpoint)) {
      throw new Error(`Circuit breaker open for ${endpoint.name}. Waiting for recovery.`);
    }

    // Wait for rate limit compliance
    await this.waitForRateLimit(endpoint, priority);

    try {
      // Record request time
      const now = Date.now();
      endpoint.requestTimes.push(now);
      this.cleanupOldRequests(endpoint);

      // Execute operation
      const result = await operation();

      // Reset failure count on success
      endpoint.consecutiveFailures = 0;
      endpoint.failureCount = Math.max(0, endpoint.failureCount - 1);

      logger.debug(`${endpoint.name} request successful`);
      return result;

    } catch (error: any) {
      await this.handleFailure(endpoint, error);
      throw error;
    }
  }

  private async waitForRateLimit(endpoint: ApiEndpoint, priority: 'high' | 'medium' | 'low') {
    const now = Date.now();
    const { config } = endpoint;

    // Clean up old request times
    this.cleanupOldRequests(endpoint);

    // Check minute limit
    const requestsInLastMinute = endpoint.requestTimes.filter(
      time => now - time < 60000
    ).length;

    // Check hour limit
    const requestsInLastHour = endpoint.requestTimes.filter(
      time => now - time < 3600000
    ).length;

    // Calculate delay based on current load and failures
    let delay = config.baseDelay;

    // Increase delay based on recent requests
    if (requestsInLastMinute >= config.maxRequestsPerMinute * 0.8) {
      delay = Math.min(delay * 2, config.maxDelay);
    }

    if (requestsInLastHour >= config.maxRequestsPerHour * 0.8) {
      delay = Math.min(delay * 1.5, config.maxDelay);
    }

    // Exponential backoff for failures
    if (endpoint.consecutiveFailures > 0) {
      delay = Math.min(
        delay * Math.pow(config.backoffMultiplier, endpoint.consecutiveFailures),
        config.maxDelay
      );
    }

    // Priority adjustments
    if (priority === 'low') {
      delay *= 1.5;
    } else if (priority === 'high') {
      delay *= 0.7;
    }

    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 0.1 * delay;
    delay += jitter;

    if (delay > config.baseDelay) {
      logger.info(`Rate limiting ${endpoint.name}: waiting ${Math.round(delay)}ms`, {
        requestsInMinute: requestsInLastMinute,
        requestsInHour: requestsInLastHour,
        consecutiveFailures: endpoint.consecutiveFailures,
        priority
      });
    }

    await this.sleep(delay);
  }

  private async handleFailure(endpoint: ApiEndpoint, error: any) {
    endpoint.consecutiveFailures++;
    endpoint.failureCount++;
    endpoint.lastFailureTime = Date.now();

    const isRateLimitError = this.isRateLimitError(error);
    const is5xxError = error.response?.status >= 500;

    if (isRateLimitError) {
      logger.warn(`Rate limit hit for ${endpoint.name}`, {
        status: error.response?.status,
        consecutiveFailures: endpoint.consecutiveFailures
      });

      // Aggressive backoff for rate limits
      const backoffTime = Math.min(
        endpoint.config.baseDelay * Math.pow(2, endpoint.consecutiveFailures),
        endpoint.config.maxDelay
      );
      await this.sleep(backoffTime);
    }

    // Open circuit breaker if too many failures
    if (endpoint.consecutiveFailures >= endpoint.config.circuitBreakerThreshold) {
      endpoint.isCircuitOpen = true;
      logger.error(`Circuit breaker opened for ${endpoint.name}`, {
        consecutiveFailures: endpoint.consecutiveFailures,
        threshold: endpoint.config.circuitBreakerThreshold
      });
    }

    logger.error(`${endpoint.name} request failed`, {
      error: error.message,
      status: error.response?.status,
      consecutiveFailures: endpoint.consecutiveFailures,
      isRateLimit: isRateLimitError,
      is5xx: is5xxError
    });
  }

  private isCircuitBreakerOpen(endpoint: ApiEndpoint): boolean {
    if (!endpoint.isCircuitOpen) return false;

    // Check if we should attempt to close the circuit
    const timeSinceLastFailure = Date.now() - endpoint.lastFailureTime;
    if (timeSinceLastFailure > endpoint.config.circuitBreakerTimeout) {
      endpoint.isCircuitOpen = false;
      endpoint.consecutiveFailures = Math.floor(endpoint.consecutiveFailures / 2);
      logger.info(`Circuit breaker closed for ${endpoint.name} (half-open state)`);
      return false;
    }

    return true;
  }

  private isRateLimitError(error: any): boolean {
    if (!error.response) return false;
    const status = error.response.status;
    const message = error.message?.toLowerCase() || '';

    return status === 429 ||
      status === 403 ||
      message.includes('rate limit') ||
      message.includes('too many requests');
  }

  private cleanupOldRequests(endpoint: ApiEndpoint) {
    const oneHourAgo = Date.now() - 3600000;
    endpoint.requestTimes = endpoint.requestTimes.filter(time => time > oneHourAgo);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Get current status of all endpoints
  getStatus(): Record<string, any> {
    const status: Record<string, any> = {};

    for (const [name, endpoint] of this.endpoints) {
      const now = Date.now();
      status[name] = {
        name: endpoint.name,
        isCircuitOpen: endpoint.isCircuitOpen,
        consecutiveFailures: endpoint.consecutiveFailures,
        totalFailures: endpoint.failureCount,
        requestsInLastMinute: endpoint.requestTimes.filter(t => now - t < 60000).length,
        requestsInLastHour: endpoint.requestTimes.filter(t => now - t < 3600000).length,
        limits: {
          perMinute: endpoint.config.maxRequestsPerMinute,
          perHour: endpoint.config.maxRequestsPerHour
        },
        lastFailure: endpoint.lastFailureTime ? new Date(endpoint.lastFailureTime) : null
      };
    }

    return status;
  }

  // Force reset an endpoint (for manual recovery)
  resetEndpoint(endpointName: string) {
    const endpoint = this.endpoints.get(endpointName);
    if (endpoint) {
      endpoint.isCircuitOpen = false;
      endpoint.consecutiveFailures = 0;
      endpoint.failureCount = 0;
      endpoint.requestTimes = [];
      logger.info(`Endpoint ${endpoint.name} has been reset`);
    }
  }
}

export const rateLimiter = new SmartRateLimiter();