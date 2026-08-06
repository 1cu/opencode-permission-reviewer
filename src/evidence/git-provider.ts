import { enrichGitEvidence } from "../git-evidence.ts"
import type { EvidenceFragment, EvidenceProvider, EvidenceProviderInput } from "./provider.ts"

/**
 * Wraps {@link enrichGitEvidence} behind the {@link EvidenceProvider} surface.
 * Git evidence resolves the repository from the planned command's directory and
 * does not depend on the worktree root, so `worktree` is accepted for interface
 * uniformity and intentionally ignored here.
 */
export class GitEvidenceProvider implements EvidenceProvider {
  readonly id = "git"
  async collect(input: EvidenceProviderInput): Promise<EvidenceFragment> {
    void input.worktree
    const result = await enrichGitEvidence(input.request, input.directory, input.maxChars)
    return { kind: "git", text: result.text }
  }
}
