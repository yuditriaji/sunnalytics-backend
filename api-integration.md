6️⃣ API Integrations
6.1. CoinGecko (Free, No API Key)

    Use /coins/markets and /coins/{id} endpoints.

    Example in api/coingecko.js:

const axios = require('axios');
const BASE = 'https://api.coingecko.com/api/v3';

async function fetchMarketData() {
  const res = await axios.get(`${BASE}/coins/markets`, {
    params: { vs_currency: 'usd', order: 'market_cap_desc', per_page: 100, page: 1 }
  });
  return res.data;
}

module.exports = { fetchMarketData };

6.2. DeBank API (Free, Rate-Limited)

    Public endpoints via https://openapi.debank.com:

    Implement smart delays and randomization.

6.3. Bitquery API (Free Tier, 100k credits/month)

    Register at Bitquery.

    Use free GraphQL endpoint.

    Implement random delays (setTimeout + Math.random) and cache results.

7️⃣ Caching Strategy

    Implement services/cache.js using in-memory JS object.

    Cache API calls for 5-10 mins to reduce API usage.

    Example:

let cache = {};

function setCache(key, data, ttl = 600) {
  cache[key] = { data, expiry: Date.now() + ttl * 1000 };
}

function getCache(key) {
  const item = cache[key];
  if (!item || Date.now() > item.expiry) return null;
  return item.data;
}

module.exports = { setCache, getCache };

8️⃣ Express API Endpoints

    GET /api/tokens → Fetch tokens (with caching, filtering by category).

    GET /api/health → Health check.

    POST /api/tokens/refresh → Refresh data manually.

🚀 Free API Handling Strategy
| Source    | Free Plan Limits                             | Strategy                             |
| --------- | -------------------------------------------- | ------------------------------------ |
| CoinGecko | Free, no key, rate-limited                   | Use cache, fetch top 100 only        |
| DeBank    | Free, no key, rate-limited                   | Random delays, cache                 |
| Bitquery  | Free 100k credits/month (1 call \~5 credits) | Limit calls, stagger requests, cache |


🔍 Core Calculation Formulas
| Metric                  | Formula                                     |                                   |
| ----------------------- | ------------------------------------------- | --------------------------------- |
| Market Cap              | `price * circulating supply`                |                                   |
| Fully Diluted Valuation | `price * total supply`                      |                                   |
| Volume/Market Cap Ratio | `24h volume / market cap`                   |                                   |
| Circulating Supply %    | `(circulating supply / total supply) * 100` |                                   |
| Potential Multiplier    | `(target market cap / current market cap)`  |                                   |
| Example Insights        | Volume/MC > 0.1 = healthy                   | Circulating Supply % > 50% = good |
