const CONNECTION_CODES = new Set([
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "ECONNRESET",
    "EPIPE",
    "08000",
    "08001",
    "08003",
    "08004",
    "08006",
    "57P01",
    "57P02",
    "57P03",
    "53300",
]);

export const is_db_connection_error = (error: unknown): boolean => {
    if (typeof error !== "object" || error === null) {
        return false;
    }

    const code = (error as {code?: unknown}).code;

    return typeof code === "string" && CONNECTION_CODES.has(code);
};
