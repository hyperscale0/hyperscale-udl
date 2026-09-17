import type { UdlDocument } from "./schema.js";
import { issue, type UdlIssue } from "./diagnostics.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => JSON.stringify(key) + ":" + stable(entry))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "undefined";
}

/** Existing instruments are frozen; a live document may add independent instruments. */
export function diffValidatedUdlEvolution(
  live: UdlDocument,
  next: UdlDocument,
): UdlIssue[] {
  const issues: UdlIssue[] = [];
  const refuse = (path: string, message: string) =>
    issues.push(issue("UDL7001", path, message));
  if (live.product !== next.product || live.currency !== next.currency)
    refuse("$", "product identity and currency are immutable");
  for (const [name, party] of Object.entries(live.parties))
    if (stable(party) !== stable(next.parties[name]))
      refuse(`$.parties.${name}`, "a live party cannot change or disappear");
  for (const instrument of live.instruments) {
    const updated = next.instruments.find((i) => i.id === instrument.id);
    if (!updated || stable(instrument) !== stable(updated))
      refuse(
        `$.instruments.${instrument.id}`,
        "a live instrument cannot change or disappear; recreate development estates",
      );
  }
  if (stable(live) !== stable(next) && next.version <= live.version)
    issues.push(
      issue(
        "UDL7002",
        "$.version",
        "a changed document needs a higher version",
      ),
    );
  return issues;
}
