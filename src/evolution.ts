import type { UdlDocument } from "./schema.js";
import { issue, type UdlIssue } from "./diagnostics.js";
import { writeJson } from "./json.js";

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
    if (
      !Object.hasOwn(next.parties, name) ||
      writeJson(party) !== writeJson(next.parties[name])
    )
      refuse(`$.parties.${name}`, "a live party cannot change or disappear");
  for (const object of live.objects) {
    const updated = next.objects.find((o) => o.id === object.id);
    if (!updated || writeJson(object) !== writeJson(updated))
      refuse(
        `$.objects.${object.id}`,
        "a live object kind cannot change or disappear; recreate development estates",
      );
  }
  for (const instrument of live.instruments) {
    const updated = next.instruments.find((i) => i.id === instrument.id);
    if (!updated || writeJson(instrument) !== writeJson(updated))
      refuse(
        `$.instruments.${instrument.id}`,
        "a live instrument cannot change or disappear; recreate development estates",
      );
  }
  if (writeJson(live) !== writeJson(next) && next.version <= live.version)
    issues.push(
      issue(
        "UDL7002",
        "$.version",
        "a changed document needs a higher version",
      ),
    );
  return issues;
}
