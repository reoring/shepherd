import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";

export interface FocusedChallenge {
  secret: string;
  profile: string;
  step: string;
}

export async function readFocusedChallenge(): Promise<FocusedChallenge> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const [line] = await once(lines, "line") as [string];
  lines.close();
  const value = JSON.parse(line) as Partial<FocusedChallenge>;
  if (
    typeof value.secret !== "string" ||
    typeof value.profile !== "string" ||
    typeof value.step !== "string"
  ) {
    throw new Error("Focused verifier challenge is invalid");
  }
  return { secret: value.secret, profile: value.profile, step: value.step };
}

/** Writes the exact host-verifiable proof format used by every focused fixture. */
export function focusedProof(challenge: FocusedChallenge): string {
  const proof = createHmac("sha256", challenge.secret)
    .update(`focused-proof\0${challenge.profile}\0${challenge.step}`)
    .digest("hex");
  return `${JSON.stringify({ proof })}\n`;
}
