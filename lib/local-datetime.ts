// Between the value of an `<input type="datetime-local">` — wall-clock time in
// the browser's own timezone, no offset — and the ISO instant the API stores.
// The browser's timezone is the right one to read it in: the owner types the
// start of their competition as they see it on their own clock.

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** An ISO instant as a `datetime-local` value in the local timezone, or "" for none. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value as an ISO instant, or `null` when empty or unreadable. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  // Without an offset, Date reads a date-time string as local time.
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
