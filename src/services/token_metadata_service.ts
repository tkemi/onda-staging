import {createPublicClient, erc20Abi, http} from "viem";
import {arbitrum} from "viem/chains";
import dotenv from "dotenv";
dotenv.config();

// An ERC-20 Transfer log carries only (from, to, value) - never the symbol or the
// decimals - so the only place to get those is the token contract itself. They are
// immutable for a given contract, so one read per address is cached for the life of
// the process: a webhook delivery with fifty transfers still makes one RPC round trip.

const public_client = createPublicClient({
    chain: arbitrum,
    transport: http(process.env.ARBITRUM_RPC_URL),
});

export interface token_metadata {
    symbol: string;
    decimals: number;
}

const cache = new Map<string, token_metadata>();

export const get_token_metadata = async (address: string): Promise<token_metadata> => {
    const key = address.toLowerCase();
    const cached = cache.get(key);

    if (cached) {
        return cached;
    }

    const [symbol, decimals] = await Promise.all([
        public_client.readContract({address: key as `0x${string}`, abi: erc20Abi, functionName: "symbol"}),
        public_client.readContract({address: key as `0x${string}`, abi: erc20Abi, functionName: "decimals"}),
    ]);

    const metadata = {symbol: symbol, decimals: Number(decimals)};
    cache.set(key, metadata);

    return metadata;
};

// Exposed for tests and for the backfill script, which must not inherit a cache
// warmed by a different token list.
export const clear_token_metadata_cache = (): void => {
    cache.clear();
};
