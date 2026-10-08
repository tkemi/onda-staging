import {z} from "zod"
import {Request, Response} from "express"
import {isAddress} from "viem";
import {register_user, resolve_privy_wallet_id, verify_privy_webhook} from "../services";

// Registration, driven by Privy rather than by a client call.
//
// The old path had the frontend POST /api/create-wallet with privyWallet, privyUserId and
// privyWalletId. Two problems with that: a wallet created ANYWHERE else - the Privy
// dashboard, a client sdk, a script - never gets a users row and so is never put on the
// quicknode watchlist, which makes every deposit to it invisible; and the wallet id arrives
// from the caller, so a wrong one is accepted and only surfaces much later when the sweeper
// tries to move money and Privy answers "Invalid wallet ID".
//
// This webhook fixes both. Privy tells us a wallet exists, and we resolve the id from
// Privy's own records rather than believing a field.
//
// The create-wallet endpoint still works and is still idempotent; this just means it is no
// longer the only way a user gets registered.

// Only EVM wallets interest us: deposits are USDC on arbitrum and hyperliquid accounts are
// evm addresses. A solana or tron wallet on the same Privy user is not ours to watch.
const ETHEREUM = "ethereum";

// The slice of Privy's payload we actually use. Loose on purpose - Privy sends dozens of
// event types and will add more, and an unexpected shape must not 500 a delivery that svix
// will then retry forever.
const walletSchema = z.object({
    address: z.string(),
    chain_type: z.string().optional(),
    // the base wallet type does not guarantee an id, so it is optional here and resolved
    // from Privy's api when missing
    id: z.string().nullish(),
});

const eventSchema = z.object({
    type: z.string(),
    user: z.object({id: z.string()}).passthrough(),
    wallet: walletSchema.optional(),
}).passthrough();

const headersSchema = z.object({
    "svix-id": z.string().min(1),
    "svix-timestamp": z.string().min(1),
    "svix-signature": z.string().min(1),
});

// What we register from. `user.wallet_created` is the event that matters: it fires with the
// wallet that was just made. `user.created` carries the user's linked accounts, which for a
// user created WITH a wallet already includes it - so handling both means we do not miss a
// registration depending on which event Privy sends first.
const REGISTERING_EVENTS = new Set(["user.wallet_created", "user.created"]);

interface candidate {
    address: string;
    wallet_id: string | null;
}

// Every evm wallet the payload mentions, from the dedicated `wallet` field and from the
// user's linked accounts.
const wallets_in = (event: {wallet?: {address: string; chain_type?: string; id?: string | null}; user: Record<string, unknown>}): candidate[] => {
    const found = new Map<string, candidate>();

    const consider = (raw: unknown): void => {
        const parsed = walletSchema.safeParse(raw);

        if (!parsed.success) {
            return;
        }

        const {address, chain_type, id} = parsed.data;

        // chain_type is absent on some shapes; an 0x address of the right length is the
        // fallback test, and isAddress also rejects a malformed one
        const is_evm = chain_type ? chain_type === ETHEREUM : isAddress(address);

        if (!is_evm || !isAddress(address)) {
            return;
        }

        const key = address.toLowerCase();

        // prefer an entry that came with an id over one that did not
        if (!found.has(key) || (id && !found.get(key)!.wallet_id)) {
            found.set(key, {address: key, wallet_id: id ?? null});
        }
    };

    consider(event.wallet);

    const linked = event.user["linked_accounts"];

    if (Array.isArray(linked)) {
        for (const account of linked) {
            consider(account);
        }
    }

    return [...found.values()];
};

export const privy_webhook = async (req: Request, res: Response) => {

    if (!process.env.PRIVY_WEBHOOK_SIGNING_KEY) {
        console.error("[privy] PRIVY_WEBHOOK_SIGNING_KEY is not set, cannot verify delivery")

        return res.status(503).json({
            status: "error",
            message: "Webhook not configured",
        });
    }

    const validateHeaders = headersSchema.safeParse({
        "svix-id": req.header("svix-id"),
        "svix-timestamp": req.header("svix-timestamp"),
        "svix-signature": req.header("svix-signature"),
    })

    if (!validateHeaders.success) {
        console.error("[privy] rejected delivery: missing svix headers")

        return res.status(400).json({
            status: "error",
            message: "Missing svix headers",
        });
    }

    // The signature covers the exact bytes Privy sent, so the raw buffer is what gets
    // verified - re-serialising req.body could reorder keys and fail a valid delivery.
    const raw = (req as Request & {rawBody?: Buffer}).rawBody

    if (!raw) {
        console.error("[privy] rejected delivery: raw body unavailable")

        return res.status(400).json({
            status: "error",
            message: "Raw body unavailable",
        });
    }

    let verified: unknown

    try {
        verified = verify_privy_webhook(raw.toString("utf8"), validateHeaders.data)
    } catch (error: unknown) {
        console.error("[privy] rejected delivery: bad signature:", error instanceof Error ? error.message : error)

        return res.status(401).json({
            status: "error",
            message: "Invalid signature",
        });
    }

    const validateEvent = eventSchema.safeParse(verified)

    if (!validateEvent.success) {
        // Acknowledge anyway. The delivery is authentic, we just do not understand it, and
        // a non-2xx would have svix retry a payload that will never parse.
        console.warn("[privy] authentic delivery with an unexpected shape, ignoring")

        return res.status(200).json({status: "ok", registered: 0});
    }

    const event = validateEvent.data

    if (!REGISTERING_EVENTS.has(event.type)) {
        // Privy sends dozens of event types on one endpoint; the rest are not ours.
        return res.status(200).json({status: "ok", registered: 0});
    }

    const candidates = wallets_in(event)

    if (candidates.length === 0) {
        console.log(`[privy] ${event.type} for ${event.user.id} carried no evm wallet`)

        return res.status(200).json({status: "ok", registered: 0});
    }

    let registered = 0
    const failures: string[] = []

    for (const candidate of candidates) {
        try {
            // Privy is the authority on the id, not the payload - see
            // resolve_privy_wallet_id. Only fall back to the payload's id if the lookup
            // finds nothing, which would mean the wallet is not on this app.
            const resolved = await resolve_privy_wallet_id(candidate.address) ?? candidate.wallet_id

            if (!resolved) {
                console.error(`[privy] no wallet id for ${candidate.address}, not registering`)
                failures.push(candidate.address)

                continue
            }

            const {user, created, watched} = await register_user(event.user.id, candidate.address, resolved)

            if (!user) {
                console.error(`[privy] ${candidate.address} could not be registered`)
                failures.push(candidate.address)

                continue
            }

            if (created) {
                registered += 1
                console.log(`[privy] registered ${candidate.address} (wallet ${resolved}), watched=${watched}`)
            }

            // A user that already existed may still be missing from the watchlist - the
            // original registration could have failed that step, which is silent until a
            // deposit goes unseen. Re-registering is a no-op on the row, so the watch is
            // the part worth retrying.
            if (!created && watched === false) {
                failures.push(candidate.address)
            }
        } catch (error: unknown) {
            console.error(`[privy] failed for ${candidate.address}:`, error instanceof Error ? error.message : error)
            failures.push(candidate.address)
        }
    }

    // A 5xx makes svix retry, which is what we want when the watchlist call or Privy's api
    // was the thing that failed - the delivery is good and a later attempt may succeed.
    if (failures.length > 0) {
        return res.status(502).json({
            status: "error",
            message: "Some wallets could not be registered or watched",
            registered: registered,
            failed: failures,
        });
    }

    return res.status(200).json({
        status: "ok",
        registered: registered,
    });
}
