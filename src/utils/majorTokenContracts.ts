/**
 * Hardcoded contract addresses for major tokens that don't have on-chain contracts
 * (native chain assets) but have wrapped/tokenized versions we can analyze.
 * 
 * This provides on-chain analytics for major tokens like BTC, ETH, etc.
 */

// Native tokens and their wrapped/tokenized contract addresses on various chains
export const MAJOR_TOKEN_CONTRACTS: Record<string, { chain: string; address: string; name: string }[]> = {
    // Bitcoin - Use WBTC on Ethereum as primary
    bitcoin: [
        { chain: 'ethereum', address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', name: 'Wrapped Bitcoin' },
        { chain: 'solana', address: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', name: 'Wrapped Bitcoin (Solana)' },
    ],

    // Ethereum - Use WETH on Ethereum
    ethereum: [
        { chain: 'ethereum', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', name: 'Wrapped Ether' },
    ],

    // Tether - native on multiple chains
    tether: [
        { chain: 'ethereum', address: '0xdac17f958d2ee523a2206206994597c13d831ec7', name: 'Tether USD' },
        { chain: 'solana', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', name: 'Tether USD (Solana)' },
    ],

    // USD Coin
    'usd-coin': [
        { chain: 'ethereum', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', name: 'USD Coin' },
        { chain: 'solana', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: 'USD Coin (Solana)' },
    ],

    // XRP - Use XRPL EVM sidechain or wrapped
    ripple: [
        { chain: 'ethereum', address: '0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe', name: 'Wrapped XRP' },
    ],

    // BNB
    binancecoin: [
        { chain: 'ethereum', address: '0xb8c77482e45f1f44de1745f52c74426c631bdd52', name: 'BNB' },
    ],

    // Solana - Use wSOL on Solana and wrapped on Ethereum
    solana: [
        { chain: 'solana', address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL' },
        { chain: 'ethereum', address: '0xd31a59c85ae9d8edefec411d448f90841571b89c', name: 'Wrapped SOL (Wormhole)' },
    ],

    // Cardano
    cardano: [
        { chain: 'ethereum', address: '0x3ee2200efb3400fabb9aacf31297cbdd1d435d47', name: 'Wrapped ADA' },
    ],

    // Dogecoin
    dogecoin: [
        { chain: 'ethereum', address: '0xba2ae424d960c26247dd6c32edc70b295c744c43', name: 'Wrapped Dogecoin' },
    ],

    // TRON
    tron: [
        { chain: 'ethereum', address: '0x50327c6c5a14dcade707abad2e27eb517df87ab5', name: 'Wrapped TRX' },
    ],

    // Avalanche
    'avalanche-2': [
        { chain: 'ethereum', address: '0x85f138bfee4ef8e540890cfb48f620571d67eda3', name: 'Wrapped AVAX' },
    ],

    // Polkadot
    polkadot: [
        { chain: 'ethereum', address: '0x7083609fce4d1d8dc0c979aab8c869ea2c873402', name: 'Wrapped DOT' },
    ],

    // Chainlink
    chainlink: [
        { chain: 'ethereum', address: '0x514910771af9ca656af840dff83e8264ecf986ca', name: 'Chainlink Token' },
    ],

    // Uniswap
    uniswap: [
        { chain: 'ethereum', address: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', name: 'Uniswap' },
    ],

    // Polygon
    'matic-network': [
        { chain: 'ethereum', address: '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0', name: 'Polygon' },
    ],

    // Litecoin
    litecoin: [
        { chain: 'ethereum', address: '0x0c7d5ae016f806603cb1782bea29ac69471cab9c', name: 'Wrapped Litecoin' },
    ],

    // Shiba Inu
    'shiba-inu': [
        { chain: 'ethereum', address: '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce', name: 'Shiba Inu' },
    ],

    // Stellar
    stellar: [
        { chain: 'ethereum', address: '0x858ac36e2282ae96b1ef9c3df5f07df556e7c4d9', name: 'Wrapped XLM' },
    ],

    // Staked Ether (Lido)
    'staked-ether': [
        { chain: 'ethereum', address: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', name: 'Lido Staked Ether' },
    ],

    // Dai
    dai: [
        { chain: 'ethereum', address: '0x6b175474e89094c44da98b954eedeac495271d0f', name: 'Dai Stablecoin' },
    ],

    // Aave
    aave: [
        { chain: 'ethereum', address: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', name: 'Aave Token' },
    ],

    // Wrapped Bitcoin
    'wrapped-bitcoin': [
        { chain: 'ethereum', address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', name: 'Wrapped Bitcoin' },
    ],
};

/**
 * Get the primary contract address for a token
 * Prioritizes Ethereum for ERC-20, then Solana
 */
export function getPrimaryContract(coingeckoId: string, preferredChain?: string): { chain: string; address: string } | null {
    const contracts = MAJOR_TOKEN_CONTRACTS[coingeckoId];
    if (!contracts || contracts.length === 0) return null;

    // If preferred chain specified, try to find it
    if (preferredChain) {
        const preferred = contracts.find(c => c.chain === preferredChain);
        if (preferred) return { chain: preferred.chain, address: preferred.address };
    }

    // Priority: ethereum > solana > others
    const ethereum = contracts.find(c => c.chain === 'ethereum');
    if (ethereum) return { chain: ethereum.chain, address: ethereum.address };

    const solana = contracts.find(c => c.chain === 'solana');
    if (solana) return { chain: solana.chain, address: solana.address };

    return { chain: contracts[0].chain, address: contracts[0].address };
}

/**
 * Check if a token is a known major native token
 */
export function isMajorNativeToken(coingeckoId: string): boolean {
    return coingeckoId in MAJOR_TOKEN_CONTRACTS;
}

export default {
    MAJOR_TOKEN_CONTRACTS,
    getPrimaryContract,
    isMajorNativeToken,
};
