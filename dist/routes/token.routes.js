"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const tokenController_1 = require("../controllers/tokenController");
const router = express_1.default.Router();
router.get('/', tokenController_1.getTokens);
router.get('/:id', tokenController_1.getTokenById);
router.post('/', tokenController_1.createToken);
router.put('/:id', tokenController_1.updateToken);
router.delete('/:id', tokenController_1.deleteToken);
router.post('/refresh', tokenController_1.refreshTokens);
exports.default = router;
