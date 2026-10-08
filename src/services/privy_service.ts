import {PrivyClient} from "@privy-io/node";

// Privy, for the two things the registration webhook needs: verifying a delivery really
// came from Privy, and resolving an address to the wallet id that actually exists.

const get_client = (): PrivyClient => {
    const app_id = process.env.PRIVY_APP_ID;
    const app_secret = process.env.PRIVY_APP_SECRET;

    if (!app_id || !app_secret) {
        throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET are required");
    }

    return new PrivyClient({appId: app_id, appSecret: app_secret});
};

// --- webhook verification ----------------------------------------------------

export interface svix_headers {
    "svix-id": string;
    "svix-timestamp": string;
    "svix-signature": string;
}

// Verifies the svix signature and that the timestamp is inside Privy's tolerance, which is
// what stops a captured delivery being replayed at us later. Throws on anything invalid.
//
// `raw` must be the UNPARSED body: the signature covers the exact bytes, so re-serialising
// a parsed object can change key order or spacing and fail a legitimate delivery. express
// stashes those bytes on request.rawBody - see the json() verify hook in src/index.ts.
export const verify_privy_webhook = (raw: string, headers: svix_headers): unknown => {
    const signing_secret = process.env.PRIVY_WEBHOOK_SIGNING_KEY;

    if (!signing_secret) {
        throw new Error("PRIVY_WEBHOOK_SIGNING_KEY is not set");
    }

    return get_client().webhooks().verify({
        payload: raw,
        headers: headers,
        signing_secret: signing_secret,
    });
};

// --- wallet id resolution ----------------------------------------------------

// The id Privy itself holds for this address, or null if Privy has no such wallet.
//
// Why this exists rather than trusting the id in the payload: `privy_wallet_id` is what the
// sweeper calls Privy with, and a wrong one is invisible until money needs to move - it
// fails with "Invalid wallet ID" at the moment of a transfer, not at registration. We have
// already had a users row carrying an id Privy 404s on. The webhook's wallet object is also
// typed as a base wallet, where `id` is not guaranteed to be present at all.
//
// So the address - which the payload always carries, and which cannot be wrong because the
// money arrives there - is the lookup key, and Privy is the authority on the id.
export const resolve_privy_wallet_id = async (address: string): Promise<string | null> => {
    const app_id = process.env.PRIVY_APP_ID;
    const app_secret = process.env.PRIVY_APP_SECRET;

    if (!app_id || !app_secret) {
        throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET are required");
    }

    const target = address.toLowerCase();
    const auth = Buffer.from(`${app_id}:${app_secret}`).toString("base64");
    let cursor: string | null = null;

    // paged, because an app accumulates wallets and the one we want may not be on page one
    for (let page = 0; page < 50; page++) {
        const query = new URLSearchParams({limit: "100"});

        if (cursor) {
            query.set("cursor", cursor);
        }

        const response = await fetch(`https://api.privy.io/v1/wallets?${query.toString()}`, {
            headers: {
                Authorization: `Basic ${auth}`,
                "privy-app-id": app_id,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`[privy] wallet list failed: ${response.status} ${await response.text()}`);
        }

        const body = await response.json() as {
            data?: {id: string; address: string}[];
            next_cursor?: string | null;
        };

        for (const wallet of body.data ?? []) {
            if ((wallet.address ?? "").toLowerCase() === target) {
                return wallet.id;
            }
        }

        cursor = body.next_cursor ?? null;

        if (!cursor) {
            break;
        }
    }

    return null;
};
