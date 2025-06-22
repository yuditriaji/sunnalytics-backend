import express from 'express';
import {
  getTokens,
  getTokenById,
  createToken,
  updateToken,
  deleteToken,
  refreshTokens,
  getTokenHistory,
  populateHeader,
  populateDetail,
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
router.post('/populate-header', populateHeader);
router.post('/populate-detail', populateDetail);
router.post('/update-token', updateTokenFromDetail);

export default router;