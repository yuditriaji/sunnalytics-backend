import express from 'express';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

// Get all altcoins
router.get('/', async (req, res) => {
  try {
    const altcoins = await prisma.token.findMany({
      where: {
        category: 'altcoin'
      }
    });
    res.json(altcoins);
  } catch (error) {
    console.error('Error fetching altcoins:', error);
    res.status(500).json({ error: 'Failed to fetch altcoins' });
  }
});

// Get a specific altcoin by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const altcoin = await prisma.token.findUnique({
      where: { id }
    });
    
    if (!altcoin) {
      return res.status(404).json({ error: 'Altcoin not found' });
    }
    
    res.json(altcoin);
  } catch (error) {
    console.error('Error fetching altcoin:', error);
    res.status(500).json({ error: 'Failed to fetch altcoin' });
  }
});

// Create a new altcoin
router.post('/', async (req, res) => {
  try {
    const { name, symbol, marketCap, volume24h, price } = req.body;
    
    const newAltcoin = await prisma.token.create({
      data: {
        name,
        symbol,
        category: 'altcoin',
        marketCap,
        volume24h,
        price
      }
    });
    
    res.status(201).json(newAltcoin);
  } catch (error) {
    console.error('Error creating altcoin:', error);
    res.status(500).json({ error: 'Failed to create altcoin' });
  }
});

// Update an altcoin
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, symbol, marketCap, volume24h, price } = req.body;
    
    const updatedAltcoin = await prisma.token.update({
      where: { id },
      data: {
        name,
        symbol,
        marketCap,
        volume24h,
        price
      }
    });
    
    res.json(updatedAltcoin);
  } catch (error) {
    console.error('Error updating altcoin:', error);
    res.status(500).json({ error: 'Failed to update altcoin' });
  }
});

// Delete an altcoin
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    await prisma.token.delete({
      where: { id }
    });
    
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting altcoin:', error);
    res.status(500).json({ error: 'Failed to delete altcoin' });
  }
});

export default router;