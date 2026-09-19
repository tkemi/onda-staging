// Paste this into the QuickNode Stream's filter function.
// Dataset: block_with_receipts (Arbitrum mainnet)
//
// It keeps only USDC Transfer logs whose recipient is in the onda_wallets
// Key-Value Store list, and returns them in the same shape the raw logs have,
// so the backend controller parses the result without any change.

const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WALLETS_LIST = "onda_wallets";

// topics carry addresses left-padded to 32 bytes, so the last 20 bytes are the address
const topic_to_address = (topic) => "0x" + topic.slice(26).toLowerCase();

async function main(stream) {
    const blocks = Array.isArray(stream.data) ? stream.data : [stream.data];

    const logs = blocks
        .flatMap((block) => block.receipts || [])
        .flatMap((receipt) => receipt.logs || [])
        .filter((log) =>
            log.address &&
            log.address.toLowerCase() === USDC &&
            log.topics &&
            log.topics.length === 3 &&
            log.topics[0].toLowerCase() === TRANSFER_TOPIC
        );

    if (logs.length === 0) {
        return null;
    }

    const recipients = logs.map((log) => topic_to_address(log.topics[2]));
    const watched = await qnLib.qnContainsListItems(WALLETS_LIST, recipients);
    const ours = logs.filter((_, i) => watched[i]);

    if (ours.length === 0) {
        return null;
    }

    return {logs: ours};
}
