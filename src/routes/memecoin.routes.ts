import express, { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

// Get all memecoins
router.get('/', async (req: Request, res: Response) => {
  try {
    const memecoins = await prisma.token.findMany({
      where: {
        category: 'memecoin'
      }
    });
    res.json(memecoins);
  } catch (error) {
    console.error('Error fetching memecoins:', error);
    res.status(500).json({ error: 'Failed to fetch memecoins' });
  }
});

// Get a specific memecoin by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const memecoin = await prisma.token.findUnique({
      where: { id }
    });
    
    if (!memecoin) {
      return res.status(404).json({ error: 'Memecoin not found' });
    }
    
    res.json(memecoin);
  } catch (error) {
    console.error('Error fetching memecoin:', error);
    res.status(500).json({ error: 'Failed to fetch memecoin' });
  }
});

// Create a new memecoin
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, symbol, marketCap, volume24h, price } = req.body;
    
    const newMemecoin = await prisma.token.create({
      data: {
        name,
        symbol,
        category: 'memecoin',
        marketCap,
        volume24h,
        price
      }
    });
    
    res.status(201).json(newMemecoin);
  } catch (error) {
    console.error('Error creating memecoin:', error);
    res.status(500).json({ error: 'Failed to create memecoin' });
  }
});

// Update a memecoin
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, symbol, marketCap, volume24h, price } = req.body;
    
    const updatedMemecoin = await prisma.token.update({
      where: { id },
      data: {
        name,
        symbol,
        marketCap,
        volume24h,
        price
      }
    });
    
    res.json(updatedMemecoin);
  } catch (error) {
    console.error('Error updating memecoin:', error);
    res.status(500).json({ error: 'Failed to update memecoin' });
  }
});

// Delete a memecoin
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    await prisma.token.delete({
      where: { id }
    });
    
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting memecoin:', error);
    res.status(500).json({ error: 'Failed to delete memecoin' });
  }
});

export default router;