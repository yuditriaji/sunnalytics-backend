import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

// Import routes
import memecoinRoutes from './routes/memecoin.routes';
import defiRoutes from './routes/defi.routes';
import altcoinRoutes from './routes/altcoin.routes';

dotenv.config();
const app = express();
const prisma = new PrismaClient();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.get('/', (_: Request, res: Response) => res.send('Sunnalytics Backend Running'));
app.use('/api/memecoins', memecoinRoutes);
app.use('/api/defi', defiRoutes);
app.use('/api/altcoins', altcoinRoutes);

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});