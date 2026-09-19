const KV_BASE = "https://api.quicknode.com/kv/rest/v1/lists";
const BATCH_SIZE = 500;

const get_config = (): {api_key: string; list_key: string} | null => {
    const api_key = process.env.QUICKNODE_API_KEY;
    const list_key = process.env.QUICKNODE_WALLETS_LIST;

    if (!api_key || !list_key) {
        return null;
    }

    return {api_key: api_key, list_key: list_key};
};

export const watch_address = async (privy_address: string, attempts = 3): Promise<boolean> => {
    const config = get_config();

    if (!config) {
        console.error(`[quicknode] not watching ${privy_address}: QUICKNODE_API_KEY or QUICKNODE_WALLETS_LIST missing`);

        return false;
    }

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await fetch(`${KV_BASE}/${config.list_key}/items`, {
                method: "POST",
                headers: {
                    "x-api-key": config.api_key,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({item: privy_address.toLowerCase()}),
            });

            if (response.ok) {
                console.log(`[quicknode] watching ${privy_address}`);

                return true;
            }

            console.error(`[quicknode] attempt ${attempt}/${attempts} for ${privy_address}: ${response.status} ${await response.text()}`);
        } catch (error: unknown) {
            console.error(`[quicknode] attempt ${attempt}/${attempts} for ${privy_address}:`, error);
        }

        if (attempt < attempts) {
            await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
        }
    }

    return false;
};

export const get_watched_addresses = async (): Promise<string[]> => {
    const config = get_config();

    if (!config) {
        throw new Error("QUICKNODE_API_KEY and QUICKNODE_WALLETS_LIST are required");
    }

    const response = await fetch(`${KV_BASE}/${config.list_key}`, {
        headers: {"x-api-key": config.api_key},
    });

    if (response.status === 404) {
        return [];
    }

    if (!response.ok) {
        throw new Error(`[quicknode] cannot read list: ${response.status} ${await response.text()}`);
    }

    const body = await response.json() as {data?: {items?: string[] | null}};

    return (body.data?.items ?? []).map((item) => item.toLowerCase());
};

export const add_watched_addresses = async (addresses: string[]): Promise<number> => {
    const config = get_config();

    if (!config) {
        throw new Error("QUICKNODE_API_KEY and QUICKNODE_WALLETS_LIST are required");
    }

    let added = 0;

    for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
        const batch = addresses.slice(i, i + BATCH_SIZE);

        const response = await fetch(`${KV_BASE}/${config.list_key}`, {
            method: "PATCH",
            headers: {
                "x-api-key": config.api_key,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({addItems: batch}),
        });

        if (!response.ok) {
            throw new Error(`[quicknode] cannot add items: ${response.status} ${await response.text()}`);
        }

        added += batch.length;
    }

    return added;
};
