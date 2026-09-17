import {createCipheriv, createDecipheriv, randomBytes, timingSafeEqual} from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const VERSION = "v1";

let cached_key: Buffer | null = null;

const get_key = (): Buffer => {
    if (cached_key) {
        return cached_key;
    }

    const raw = process.env.ENCRYPTION_KEY;

    if (!raw) {
        throw new Error("ENCRYPTION_KEY is required. Generate one with: openssl rand -hex 32");
    }

    const key = Buffer.from(raw, "hex");

    if (key.length !== 32) {
        throw new Error(
            `ENCRYPTION_KEY must be 32 bytes as 64 hex characters, got ${key.length} bytes`
        );
    }

    cached_key = key;

    return key;
};

export const encrypt = (plaintext: string): string => {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, get_key(), iv);

    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const auth_tag = cipher.getAuthTag();

    return [
        VERSION,
        iv.toString("base64"),
        auth_tag.toString("base64"),
        ciphertext.toString("base64"),
    ].join(":");
};

export const decrypt = (payload: string): string => {
    const parts = payload.split(":");

    if (parts.length !== 4) {
        throw new Error("Malformed ciphertext");
    }

    const [version, iv_b64, tag_b64, ciphertext_b64] = parts as [string, string, string, string];

    if (version !== VERSION) {
        throw new Error(`Unsupported ciphertext version: ${version}`);
    }

    const decipher = createDecipheriv(ALGORITHM, get_key(), Buffer.from(iv_b64, "base64"));
    decipher.setAuthTag(Buffer.from(tag_b64, "base64"));

    return Buffer.concat([
        decipher.update(Buffer.from(ciphertext_b64, "base64")),
        decipher.final(),
    ]).toString("utf8");
};

export const is_encrypted = (value: string): boolean => value.startsWith(`${VERSION}:`);
