import { Connection, PublicKey, ParsedInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import axios from 'axios';
import { logger } from '../services/logger';
import { cache } from '../services/cache';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

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
        vs_currencies: 'usd',
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
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

async function getSolanaTokenList(): Promise<{ address: string; symbol: string; name: string; coingeckoId?: string }[]> {
  const cacheKey = 'solana_token_list';
  const cachedList = cache.get<{ address: string; symbol: string; name: string; coingeckoId?: string }[]>(cacheKey);
  if (cachedList) {
    logger.info('Using cached Solana token list');
    return cachedList;
  }

  try {
    const response = await axios.get(`${COINGECKO_BASE}/coins/markets`, {
      params: {
        vs_currency: 'usd',
        order: 'market_cap_desc',
        per_page: 100,
        page: 1,
        sparkline: false,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });

    const tokens = response.data
      .filter((token: any) => token.platforms && token.platforms.solana && token.platforms.solana.length > 0)
      .map((token: any) => ({
        address: token.platforms.solana,
        symbol: token.symbol.toLowerCase(),
        name: token.name,
        coingeckoId: token.id,
      }));

    if (tokens.length === 0) {
      logger.warn('No Solana tokens found in CoinGecko response');
    } else {
      cache.set(cacheKey, tokens, 86400); // Cache for 24 hours
    }

    return tokens;
  } catch (error: any) {
    logger.error(`Failed to fetch Solana token list: ${error.message}`);
    return [];
  }
}

export async function fetchBitqueryTokens(maxRetries = 3): Promise<BitqueryToken[]> {
  const cacheKey = 'solana_tokens';
  const cachedData = cache.get<BitqueryToken[]>(cacheKey);
  if (cachedData) {
    logger.info('Using cached Solana tokens');
    return cachedData;
  }

  const tokenList = await getSolanaTokenList();
  const tokens: BitqueryToken[] = [];
  const oneDayAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

  if (tokenList.length === 0) {
    logger.warn('No Solana token mints found');
    return [];
  }

  logger.info(`Querying ${tokenList.length} Solana token mints`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const connection = new Connection(SOLANA_RPC, 'confirmed');

    try {
      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));

      for (const token of tokenList) {
        try {
          if (!(await isValidSplToken(connection, token.address))) {
            logger.warn(`Invalid SPL token mint: ${token.address}`);
            continue;
          }

          const mintPubkey = new PublicKey(token.address);
          const signatures = await connection.getSignaturesForAddress(mintPubkey, { limit: 100 });

          logger.info(`Fetched ${signatures.length} signatures for mint ${token.address} on attempt ${attempt}`);

          if (!signatures.length) {
            logger.warn(`No recent transfers for mint ${token.address} on ${SOLANA_RPC}`);
            continue;
          }

          const price = token.coingeckoId ? await getTokenPrice(token.coingeckoId) : 0;
          let totalTransferAmount = 0;

          for (const sig of signatures.slice(0, 20)) {
            try {
              if (sig.blockTime && sig.blockTime < oneDayAgo) {
                logger.debug(`Skipping old transaction ${sig.signature} (blockTime: ${sig.blockTime})`);
                continue;
              }

              const tx = await connection.getParsedTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0,
              });
              if (!tx) {
                logger.warn(`Transaction ${sig.signature} not found`);
                continue;
              }

              logger.debug(`Processing transaction ${sig.signature} for mint ${token.address}`);

              for (const ix of tx.transaction.message.instructions) {
                if ('programId' in ix && ix.programId.equals(TOKEN_PROGRAM_ID) && isParsedInstruction(ix)) {
                  const parsedInfo = ix.parsed;
                  logger.debug(`Instruction type: ${parsedInfo.type}, mint: ${parsedInfo.info?.mint}`);
                  if (
                    ['transfer', 'transferChecked'].includes(parsedInfo.type) &&
                    parsedInfo.info.mint === token.address
                  ) {
                    const amount =
                      parseFloat(parsedInfo.info.amount || parsedInfo.info.tokenAmount?.amount || '0') / 1e6; // Adjust decimals as needed
                    totalTransferAmount += amount * price;
                    logger.info(`Found transfer in ${sig.signature}: ${amount} ($${totalTransferAmount.toFixed(2)})`);
                  }
                }
              }
            } catch (error: any) {
              logger.warn(`Error parsing transaction ${sig.signature}: ${error.message}`);
            }
          }

          if (totalTransferAmount > 0) {
            tokens.push({
              address: token.address,
              name: token.name,
              symbol: token.symbol,
              price,
              transferAmount: totalTransferAmount,
              coingeckoId: token.coingeckoId,
            });
          }
        } catch (error: any) {
          logger.warn(`Error processing mint ${token.address} on ${SOLANA_RPC}: ${error.message}`);
        }
      }

      const uniqueTokens = Array.from(new Map(tokens.map((t) => [t.address, t])).values());

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