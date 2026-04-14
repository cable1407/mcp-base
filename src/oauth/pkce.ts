import { createHash } from "node:crypto";
import { timingSafeEqualStrings } from "../html.ts";
import type { CodeChallengeMethod } from "./types.ts";

export interface VerifyPkceArgs {
  verifier: string;
  challenge: string;
  method: CodeChallengeMethod;
}

export function verifyPkce({ verifier, challenge, method }: VerifyPkceArgs): boolean {
  if (method === "plain") return timingSafeEqualStrings(verifier, challenge);
  if (method === "S256") {
    const hash = createHash("sha256").update(verifier).digest("base64url");
    return timingSafeEqualStrings(hash, challenge);
  }
  throw new Error(`unsupported code_challenge_method: ${method}`);
}
