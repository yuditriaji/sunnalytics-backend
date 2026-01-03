import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

class DatabaseService {
  private static instance: DatabaseService;
  private prisma: PrismaClient | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000; // Start with 1 second
  private isConnecting = false;

  private constructor() {
    this.initializePrisma();
  }

  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  private initializePrisma() {
    try {
      this.prisma = new PrismaClient({
        log: ['error', 'warn'],
        datasources: {
          db: {
            url: process.env.DATABASE_URL,
          },
        },
        errorFormat: 'minimal',
      });

      // Connection initialized

      // Test connection on initialization
      this.testConnection();
    } catch (error: any) {
      logger.error('Failed to initialize Prisma client:', error.message);
      this.scheduleReconnect();
    }
  }

  private async testConnection(): Promise<boolean> {
    if (!this.prisma) return false;
    
    try {
      await this.prisma.$executeRaw`SELECT 1`;
      logger.info('Database connection established successfully');
      this.reconnectAttempts = 0; // Reset attempts on successful connection
      return true;
    } catch (error: any) {
      logger.error('Database connection test failed:', error.message);
      return false;
    }
  }

  private scheduleReconnect() {
    if (this.isConnecting || this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    this.isConnecting = true;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts); // Exponential backoff
    
    logger.warn(`Scheduling database reconnection attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts} in ${delay}ms`);
    
    setTimeout(async () => {
      this.reconnectAttempts++;
      await this.reconnect();
      this.isConnecting = false;
    }, delay);
  }

  private async reconnect() {
    try {
      if (this.prisma) {
        await this.prisma.$disconnect();
        this.prisma = null;
      }
      
      this.initializePrisma();
      
      if (await this.testConnection()) {
        logger.info('Database reconnected successfully');
        return;
      }
    } catch (error: any) {
      logger.error('Database reconnection failed:', error.message);
    }
    
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      logger.error('Max reconnection attempts reached. Manual intervention required.');
    }
  }

  public async executeWithRetry<T>(operation: (prisma: PrismaClient) => Promise<T>, retries = 3): Promise<T> {
    if (!this.prisma) {
      throw new Error('Database connection not available');
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await operation(this.prisma);
      } catch (error: any) {
        const isConnectionError = 
          error.message.includes('Server has closed the connection') ||
          error.message.includes('Connection terminated') ||
          error.message.includes('connect ECONNREFUSED') ||
          error.message.includes('timeout') ||
          error.code === 'P1017' || // Connection URL invalid
          error.code === 'P1001' || // Can't reach database server
          error.code === 'P1008' || // Operations timed out
          error.code === 'P1011';   // Error opening a TLS connection

        if (isConnectionError && attempt < retries) {
          logger.warn(`Database operation failed (attempt ${attempt}/${retries}): ${error.message}. Retrying...`);
          
          // Try to reconnect if connection error
          if (!await this.testConnection()) {
            this.scheduleReconnect();
            
            // Wait for potential reconnection
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
          
          continue;
        }
        
        // Re-throw the error if it's not a connection error or we've exhausted retries
        throw error;
      }
    }
    
    throw new Error('All retry attempts exhausted');
  }

  public async getClient(): Promise<PrismaClient> {
    if (!this.prisma) {
      throw new Error('Database connection not available');
    }
    
    // Test connection before returning client
    if (!await this.testConnection()) {
      throw new Error('Database connection is not healthy');
    }
    
    return this.prisma;
  }

  public async disconnect(): Promise<void> {
    if (this.prisma) {
      await this.prisma.$disconnect();
      this.prisma = null;
      logger.info('Database connection closed');
    }
  }

  public async checkHealth(): Promise<{ status: 'healthy' | 'unhealthy'; details: string }> {
    if (!this.prisma) {
      return { status: 'unhealthy', details: 'No database connection' };
    }

    try {
      const start = Date.now();
      await this.prisma.$executeRaw`SELECT 1`;
      const responseTime = Date.now() - start;
      
      return { 
        status: 'healthy', 
        details: `Connection healthy (${responseTime}ms response time)` 
      };
    } catch (error: any) {
      return { 
        status: 'unhealthy', 
        details: `Connection failed: ${error.message}` 
      };
    }
  }
}

// Export singleton instance
export const databaseService = DatabaseService.getInstance();

// Export convenience functions
export async function withDatabase<T>(operation: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  return databaseService.executeWithRetry(operation);
}

export async function getPrisma(): Promise<PrismaClient> {
  return databaseService.getClient();
}

// Graceful shutdown handler
process.on('beforeExit', async () => {
  await databaseService.disconnect();
});

process.on('SIGINT', async () => {
  await databaseService.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await databaseService.disconnect();
  process.exit(0);
});