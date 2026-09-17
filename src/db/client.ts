import dotenv from "dotenv";
import {drizzle} from "drizzle-orm/node-postgres";
import {Pool} from "pg";
import * as schema from "./schema";

dotenv.config({quiet: true});

const database_url = process.env.DATABASE_URL;

if (!database_url) {
    throw new Error("DATABASE_URL is required");
}

export const pool = new Pool({
    connectionString: database_url,
    max: 10,
    connectionTimeoutMillis: 5000,
});

pool.on("error", (error: Error) => {
    console.error("[postgres] idle client error:", error.message);
});

export const db = drizzle(pool, {schema});

export const check_db_connection = async (): Promise<void> => {
    await pool.query("select 1");
};

export const close_db = async (): Promise<void> => {
    await pool.end();
};
