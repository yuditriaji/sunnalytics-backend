import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { databaseService } from './services/database';
import { logger } from './services/logger';
import tokenRoutes from './routes/token.routes';
import userRoutes from './routes/user.routes';
import alertRoutes from './routes/alert.routes';
import subscriptionRoutes from './routes/subscription.routes';
import { validateEnhancedEnv } from './utils/enhancedValidation';
import { dataQualityMonitor } from './services/dataQuality';

dotenv.config();
validateEnhancedEnv();

const app = express();

// CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGINS?.split(',') ?? ['http://localhost:3000', 'https://sunnalytics.vercel.app'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Stripe webhook needs raw body - must be before express.json()
app.use('/api/subscription/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

// Routes
app.get('/', (_: Request, res: Response) => res.send('Sunnalytics Backend Running'));
app.get('/api/health', async (_: Request, res: Response) => {
  try {
    const healthStatuses = await dataQualityMonitor.checkAllSources();
    const overallHealth = dataQualityMonitor.getOverallHealth();

    // Get rate limiter status
    let rateLimiterStatus = null;
    try {
      const { rateLimiter } = await import('./services/rateLimiter');
      rateLimiterStatus = rateLimiter.getStatus();
    } catch (error) {
      // Rate limiter not available
    }

    res.status(overallHealth === 'critical' ? 503 : 200).json({
      status: overallHealth,
      timestamp: new Date().toISOString(),
      services: healthStatuses,
      uptime: process.uptime(),
      rateLimiter: rateLimiterStatus
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'critical',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Rate limiter status endpoint
app.get('/api/rate-limiter-status', async (_: Request, res: Response) => {
  try {
    const { rateLimiter } = await import('./services/rateLimiter');
    const status = rateLimiter.getStatus();

    const healthyCount = Object.values(status).filter(endpoint => !endpoint.isCircuitOpen).length;
    const openCircuitCount = Object.values(status).filter(endpoint => endpoint.isCircuitOpen).length;

    res.json({
      totalEndpoints: Object.keys(status).length,
      healthyEndpoints: healthyCount,
      circuitOpenEndpoints: openCircuitCount,
      endpoints: status
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'Failed to get rate limiter status',
      message: error.message
    });
  }
});

// API Routes
app.use('/api/tokens', tokenRoutes);
app.use('/api/users', userRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/subscription', subscriptionRoutes);

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  logger.error(`Error in ${req.method} ${req.url}: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down server...');
  await databaseService.disconnect();
  process.exit(0);
});
