"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cache = exports.Cache = void 0;
class Cache {
    store = new Map();
    cleanupInterval;
    constructor() {
        // Clean up expired entries every 10 minutes
        this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    }
    set(key, data, ttl = 600) {
        this.store.set(key, {
            data,
            expiry: Date.now() + ttl * 1000
        });
    }
    get(key) {
        const item = this.store.get(key);
        if (!item || Date.now() > item.expiry) {
            this.store.delete(key);
            return null;
        }
        return item.data;
    }
    cleanup() {
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
exports.Cache = Cache;
exports.cache = new Cache();
