// Pure setup-lifecycle logic: given a pre-entry setup and the current price, decide the
// next status and whether an event fired. No DB or network, so it is easy to test.
//
// PROVISIONAL (to be tuned in the invalidation/duration discussion):
//   - armed when price is within ARM_THRESHOLD of the entry zone's near edge
//   - triggered when price is inside [entry_low, entry_high]
//   - invalidated when price passes the stop side before entry was ever reached
//   - expired when now is past the setup's expires_at
// Post-entry management (breakeven / partial TPs / trailing) is per-user and handled by
// the position layer, not here.

export type setup_event = "armed" | "triggered" | "invalidated" | "expired";

export interface eval_input {
    status: string;
    direction: "long" | "short";
    entry_low: number;
    entry_high: number;
    sl: number | null;
    expires_at: Date | null;
}

export interface eval_result {
    status: string;
    event: setup_event | null;
}

// how close to the entry zone (fraction of the near-edge price) counts as "armed"
export const ARM_THRESHOLD = 0.005; // 0.5%

const PRE_ENTRY = new Set(["pending", "armed"]);

export const evaluate_setup = (setup: eval_input, price: number, now: Date): eval_result => {
    // only pre-entry states transition here; anything else is terminal or owned elsewhere
    if (!PRE_ENTRY.has(setup.status)) {
        return {status: setup.status, event: null};
    }

    if (setup.expires_at && now.getTime() > setup.expires_at.getTime()) {
        return {status: "expired", event: "expired"};
    }

    if (price >= setup.entry_low && price <= setup.entry_high) {
        return {status: "triggered", event: "triggered"};
    }

    // invalidated: price has run past the stop without ever filling the entry
    if (setup.sl !== null) {
        const past_stop = setup.direction === "long" ? price <= setup.sl : price >= setup.sl;

        if (past_stop) {
            return {status: "invalidated", event: "invalidated"};
        }
    }

    // arm when price approaches the edge it would hit first on the way into the zone
    const near_edge = setup.direction === "long" ? setup.entry_high : setup.entry_low;

    if (near_edge !== 0 && Math.abs(price - near_edge) / Math.abs(near_edge) <= ARM_THRESHOLD) {
        // only emit on the pending -> armed transition, and keep armed sticky afterwards
        return {status: "armed", event: setup.status === "armed" ? null : "armed"};
    }

    return {status: setup.status, event: null};
};
