import { extractTicketId } from "./git";
import type { Session } from "../types";

/** Build a display label: ticket+name > ticket+suffix > name > branch */
export function buildSessionLabel(session: Session): string {
  const ticket = extractTicketId(session.branch);
  const name = session.name;
  if (ticket && name) return `${ticket} · ${name}`;
  if (ticket) {
    let suffix = session.branch.includes("/") ? session.branch.split("/").pop()! : session.branch;
    suffix = suffix.replace(new RegExp(`^${ticket}-?`, "i"), "");
    return suffix ? `${ticket} · ${suffix}` : ticket;
  }
  if (name) return name;
  return session.branch;
}
