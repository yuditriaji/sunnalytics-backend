import express from 'express';
import { getTokens, getTokenById, createToken, updateToken, deleteToken, refreshTokens, getTokenHistory } from '../controllers/tokenController';

const router = express.Router();

router.get('/', getTokens);
router.get('/:id', getTokenById);
router.get('/:id/history', getTokenHistory);
router.post('/', createToken);
router.put('/:id', updateToken);
router.delete('/:id', deleteToken);
router.post('/refresh', refreshTokens);

export default router;