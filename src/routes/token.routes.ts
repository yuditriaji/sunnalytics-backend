import express from 'express';
import {
  getTokens,
  getTokenById,
  createToken,
  updateToken,
  deleteToken,
  refreshTokens,
  refreshTokensAlternative,
  refreshExchangeTokens,
  refreshContractAddresses,
  refreshOnChainAnalytics,
  getTokenHistory,
  populateHeader,
  populateDetail,
  populateExchangeTokens,
  updateTokenFromDetail,
} from '../controllers/tokenController';

const router = express.Router();

router.get('/', getTokens);
router.get('/:id', getTokenById);
router.get('/:id/history', getTokenHistory);
router.post('/', createToken);
router.put('/:id', updateToken);
router.delete('/:id', deleteToken);
router.post('/refresh', refreshTokens);
router.post('/refresh-alternative', refreshTokensAlternative); // Uses CoinPaprika/CoinLore (no rate limits)
router.post('/refresh-exchange', refreshExchangeTokens); // Only tokens listed on Binance, Bybit, HTX, MEXC, Gate.io
router.post('/refresh-contracts', refreshContractAddresses); // Populate contract addresses from CoinPaprika
router.post('/refresh-onchain', refreshOnChainAnalytics); // Populate on-chain analytics (liquidity, holders)
router.post('/populate-header', populateHeader);
router.post('/populate-exchange-tokens', populateExchangeTokens);
router.post('/populate-detail', populateDetail);
router.post('/update-token', updateTokenFromDetail);

// Rate limiter status endpoint
router.get('/rate-limiter-status', async (req: any, res: any) => {
  try {
    const { rateLimiter } = await import('../services/rateLimiter');
    const status = rateLimiter.getStatus();
    res.json({
      status: 'success',
      endpoints: status,
      summary: {
        totalEndpoints: Object.keys(status).length,
        circuitOpenCount: Object.values(status).filter((s: any) => s.isCircuitOpen).length,
        healthyEndpoints: Object.values(status).filter((s: any) => !s.isCircuitOpen && s.consecutiveFailures === 0).length
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to get rate limiter status', message: error.message });
  }
});

export default router;