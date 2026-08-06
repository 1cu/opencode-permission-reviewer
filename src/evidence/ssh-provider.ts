import { enrichSshEvidence } from "../ssh-evidence.ts"
import type { EvidenceFragment, EvidenceProvider, EvidenceProviderInput } from "./provider.ts"

/**
 * Wraps {@link enrichSshEvidence} behind the {@link EvidenceProvider} surface so
 * the assembler can treat all evidence sources uniformly. SSH is the only
 * provider that can produce a deterministic preflight denial or an audit trail.
 */
export class SshEvidenceProvider implements EvidenceProvider {
  readonly id = "ssh"
  async collect(input: EvidenceProviderInput): Promise<EvidenceFragment> {
    const result = await enrichSshEvidence(
      input.request,
      input.directory,
      input.worktree,
      input.maxChars,
    )
    return {
      kind: "ssh",
      text: result.text,
      audit: result.audit,
      ...(result.preflightDenial === undefined ? {} : { preflightDenial: result.preflightDenial }),
    }
  }
}
