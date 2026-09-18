import { z } from "zod";

/**
 * The password rule, in one place. Four writers have to agree on it —
 * registration, invite activation, this change endpoint and (later) reset by
 * email — and before this they each spelled `z.string().min(8)` for
 * themselves. `errors.passwordMin` in the message catalogues is the wording
 * that goes with it.
 */
export const PASSWORD_MIN_LENGTH = 8;

export const passwordField = z.string().min(PASSWORD_MIN_LENGTH);
