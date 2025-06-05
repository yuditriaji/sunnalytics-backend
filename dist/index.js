"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const prisma_1 = require("./services/prisma");
const logger_1 = require("./services/logger");
const token_routes_1 = __importDefault(require("./routes/token.routes"));
const validation_1 = require("./utils/validation");
dotenv_1.default.config();
(0, validation_1.validateEnv)();
const app = (0, express_1.default)();
// CORS configuration
const corsOptions = {
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
};
app.use((0, cors_1.default)(corsOptions));
// Rate limiting
const limiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per window
    standardHeaders: true,
    legacyHeaders: false
});
app.use(limiter);
app.use(express_1.default.json());
// Routes
app.get('/', (_, res) => res.send('Sunnalytics Backend Running'));
app.get('/api/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.use('/api/tokens', token_routes_1.default);
// Error handling middleware
app.use((err, req, res, next) => {
    logger_1.logger.error(`Error in ${req.method} ${req.url}: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => logger_1.logger.info(`Server running on port ${PORT}`));
// Graceful shutdown
process.on('SIGINT', async () => {
    logger_1.logger.info('Shutting down server...');
    await prisma_1.prisma.$disconnect();
    process.exit(0);
});
