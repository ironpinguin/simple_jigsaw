/**
 * `fetch` that reports a request which never reached the server as `null`
 * instead of rejecting.
 *
 * Catches the network call and nothing else, which is the whole point: a bug in
 * the response handling must not be reported to the user as a failed request,
 * because by then the request may well have succeeded. Callers keep their own
 * `try` around the part that reads the body.
 *
 * `scope` is the log prefix — "admin", "my" — so one grep finds every failed
 * request from a given surface.
 */
export async function tryFetch(
  scope: string,
  input: string,
  init?: RequestInit,
): Promise<Response | null> {
  try {
    return await fetch(input, init);
  } catch (err) {
    console.error(`[${scope}] request to ${input} failed:`, err);
    return null;
  }
}
