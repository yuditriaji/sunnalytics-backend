import { Connection, PublicKey, ParsedInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import axios from 'axios';
import { logger } from '../services/logger';
import { cache } from '../services/cache';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const TOKEN_LIST = [
  {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    name: 'USD Coin (Solana)',
    symbol: 'USDC',
    coingeckoId: 'usd-coin',
    decimals: 6
  },
  {
    address: 'So11111111111111111111111111111111111111112',
    name: 'Solana',
    symbol: 'SOL',
    coingeckoId: 'solana',
    decimals: 9
  },
  {
    address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    name: 'Jupiter',
    symbol: 'JUP',
    coingeckoId: 'jupiter-exchange-solana',
    decimals: 6
  },
  {
    address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    name: 'Bonk',
    symbol: 'BONK',
    coingeckoId: 'bonk',
    decimals: 5
  },
  {
    address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    name: 'USDT (Solana)',
    symbol: 'USDT',
    coingeckoId: 'tether',
    decimals: 6
  }
];

export interface BitqueryToken {
  address: string;
  name: string;
  symbol: string;
  price: number;
  transferAmount?: number;
  coingeckoId?: string;
}

async function getTokenPrice(coingeckoId: string): Promise<number> {
  try {
    const response = await axios.get(`${COINGECKO_BASE}/simple/price`, {
      params: {
        ids: coingeckoId,
        vs_currencies: 'usd'
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    });
    const price = response.data[coingeckoId]?.usd;
    if (typeof price !== 'number') {
      throw new Error(`Invalid price for ${coingeckoId}`);
    }
    return price;
  } catch (error: any) {
    logger.error(`CoinGecko price fetch failed for ${coingeckoId}: ${error.message}`);
    return 0;
  }
}

async function isValidSplToken(connection: Connection, mintAddress: string): Promise<boolean> {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const accountInfo = await connection.getAccountInfo(mintPubkey);
    return accountInfo?.owner.equals(TOKEN_PROGRAM_ID) ?? false;
  } catch (error: any) {
    logger.warn(`SPL validation failed for ${mintAddress}: ${error.message}`);
    return true;
  }
}

function isParsedInstruction(ix: any): ix is ParsedInstruction {
  return ix && 'parsed' in ix && typeof ix.parsed === 'object';
}

export async function fetchBitqueryTokens(maxRetries = 3): Promise<BitqueryToken[]> {
  const cacheKey = 'solana_tokens';
  const cachedData = cache.get<BitqueryToken[]>(cacheKey);
  if (cachedData) {
    logger.info('Using cached Solana tokens');
    return cachedData;
  }

  const tokens: BitqueryToken[] = [];
  const tokenMints = TOKEN_LIST.map(t => t.address);
  const oneDayAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

  logger.info(`Querying mints: ${tokenMints.join(', ')}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const connection = new Connection(SOLANA_RPC, 'confirmed');

    try {
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));

      for (const mintAddress of tokenMints) {
        try {
          if (!(await isValidSplToken(connection, mintAddress))) {
            logger.warn(`Invalid SPL token mint: ${mintAddress}`);
            continue;
          }

          const mintPubkey = new PublicKey(mintAddress);
          const signatures = await connection.getSignaturesForAddress(mintPubkey, {
            limit: 100
          });

          logger.info(`Fetched ${signatures.length} signatures for mint ${mintAddress} on attempt ${attempt}`);

          if (!signatures.length) {
            logger.warn(`No recent transfers for mint ${mintAddress} on ${SOLANA_RPC}`);
            continue;
          }

          const tokenInfo = TOKEN_LIST.find(t => t.address === mintAddress)!;
          const price = await getTokenPrice(tokenInfo.coingeckoId);
          let totalTransferAmount = 0;

          for (const sig of signatures.slice(0, 20)) {
            try {
              if (sig.blockTime && sig.blockTime < oneDayAgo) {
                logger.debug(`Skipping old transaction ${sig.signature} (blockTime: ${sig.blockTime})`);
                continue;
              }

              const tx = await connection.getParsedTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0
              });
              if (!tx) {
                logger.warn(`Transaction ${sig.signature} not found`);
                continue;
              }

              logger.debug(`Processing transaction ${sig.signature} for mint ${mintAddress}`);

              for (const ix of tx.transaction.message.instructions) {
                if ('programId' in ix && ix.programId.equals(TOKEN_PROGRAM_ID) && isParsedInstruction(ix)) {
                  const parsedInfo = ix.parsed;
                  logger.debug(`Instruction type: ${parsedInfo.type}, mint: ${parsedInfo.info?.mint}`);
                  if (
                    ['transfer', 'transferChecked'].includes(parsedInfo.type) &&
                    parsedInfo.info.mint === mintAddress
                  ) {
                    const amount = parseFloat(parsedInfo.info.amount || parsedInfo.info.tokenAmount?.amount || '0') /
                      Math.pow(10, tokenInfo.decimals);
                    totalTransferAmount += amount * price;
                    logger.info(`Found transfer in ${sig.signature}: ${amount} ${tokenInfo.symbol} ($${totalTransferAmount.toFixed(2)})`);
                  }
                }
              }
            } catch (error: any) {
              logger.warn(`Error parsing transaction ${sig.signature}: ${error.message}`);
            }
          }

          if (totalTransferAmount > 0) {
            tokens.push({
              address: mintAddress,
              name: tokenInfo.name,
              symbol: tokenInfo.symbol,
              price,
              transferAmount: totalTransferAmount,
              coingeckoId: tokenInfo.coingeckoId
            });
          }
        } catch (error: any) {
          logger.warn(`Error processing mint ${mintAddress} on ${SOLANA_RPC}: ${error.message}`);
        }
      }

      const uniqueTokens = Array.from(
        new Map(tokens.map(t => [t.address, t])).values()
      ).slice(0, 100);

      if (!uniqueTokens.length) {
        logger.warn('No valid Solana token transfers found after processing');
        return [];
      }

      logger.info(`Solana RPC call successful, attempt ${attempt}, fetched ${uniqueTokens.length} tokens on ${SOLANA_RPC}`);
      cache.set(cacheKey, uniqueTokens, 300);
      return uniqueTokens;
    } catch (error: any) {
      logger.error(`Solana RPC error, attempt ${attempt} on ${SOLANA_RPC}: ${error.message}`);
      if (attempt === maxRetries) throw new Error('Failed to fetch Solana data after retries');
    }
  }
  throw new Error('Unexpected error in fetchBitqueryTokens');
}
