interface CacheItem<T> {
  data: T;
  expiry: number;
}

export class Cache {
  private store: Map<string, CacheItem<any>> = new Map();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Clean up expired entries every 10 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);
  }

  set<T>(key: string, data: T, ttl: number = 600): void {
    this.store.set(key, {
      data,
      expiry: Date.now() + ttl * 1000
    });
  }

  get<T>(key: string): T | null {
    const item = this.store.get(key);
    if (!item || Date.now() > item.expiry) {
      this.store.delete(key);
      return null;
    }
    return item.data as T;
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, item] of this.store) {
      if (now > item.expiry) {
        this.store.delete(key);
      }
    }
  }

  // Clear interval on shutdown
  destroy() {
    clearInterval(this.cleanupInterval);
  }
}

export const cache = new Cache();