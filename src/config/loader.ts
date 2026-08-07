import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseJsonc } from "./jsonc.ts"
import { resolveConfig, DEFAULT_CONFIG, DEFAULT_RISK_POLICY } from "../config.ts"
import type { PolicyRule, ReviewerConfig } from "../types.ts"

/** Read a JSONC config file; return an empty record on any error (missing,
 *  unreadable, or malformed). Never throws. */
function readConfigFile(path: string): Record<string, unknown> {
  try {
    return parseJsonc(readFileSync(path, "utf8"))
  } catch {
    return {}
  }
}

/** Path to the global user config. Exposed for testability. */
export function globalConfigPath(): string {
  return join(homedir(), ".config", "opencode", "permission-reviewer.jsonc")
}

/** Path to the project-local config. Exposed for testability. */
export function projectConfigPath(directory: string): string {
  return join(directory, ".opencode", "permission-reviewer.jsonc")
}

/** Load and merge config from global, project, and inline sources.
 *
 * Precedence (lowest to highest): builtin defaults → global → project → inline.
 * The trust boundary ensures project config can only TIGHTEN security-sensitive
 * fields, never weaken them (lower confidence thresholds, widen risk cells,
 * disable audit, set trusted repository trust, or enable enforcement).
 *
 * When no global or project files exist (the common case), the result is
 * byte-identical to calling `resolveConfig(inlineOptions)` directly. */
export function loadResolvedConfig(
  inlineOptions: Record<string, unknown> | undefined,
  directory?: string,
): ReviewerConfig {
  const globalRaw = readConfigFile(globalConfigPath())
  const projectRaw = directory !== undefined ? readConfigFile(projectConfigPath(directory)) : {}

  // The trusted baseline is seeded with builtin defaults so clamping always
  // has a floor to compare against, even when global/inline omit a field.
  const trusted: Record<string, unknown> = {
    ...DEFAULT_CONFIG,
    ...globalRaw,
    ...(inlineOptions ?? {}),
  }
  const merged = mergeWithTrustBoundary(trusted, projectRaw)
  return resolveConfig(merged)
}

/** Merge the trusted baseline with the untrusted project layer. Project config
 *  can only TIGHTEN security-sensitive fields, never weaken them. */
function mergeWithTrustBoundary(
  trusted: Record<string, unknown>,
  project: Record<string, unknown>,
): Record<string, unknown> {
  const clamped = { ...project }

  // confidenceThreshold: project can raise but not lower it.
  if (
    typeof clamped.confidenceThreshold === "number" &&
    typeof trusted.confidenceThreshold === "number" &&
    clamped.confidenceThreshold < trusted.confidenceThreshold
  ) {
    clamped.confidenceThreshold = trusted.confidenceThreshold
  }

  // audit: project can enable but not disable.
  if (clamped.audit === false && trusted.audit !== false) {
    delete clamped.audit
  }

  // auditPath: only trusted global/inline config may choose the audit
  // destination. A repository must never be able to redirect or silence the
  // audit trail by pointing it at /dev/null or a path it controls.
  delete clamped.auditPath

  // repositoryTrust: project cannot set "trusted" — only global/inline can.
  if (clamped.repositoryTrust === "trusted") {
    delete clamped.repositoryTrust
  }

  // actorProfiles: name→profile mappings are a trust delegation (which agent
  // gets which capability profile). Only trusted global/inline config may
  // grant them; otherwise a repository could promote its own agent to a
  // higher-privilege profile ("build" → "operator"). trustedProjects opt-in is
  // a future item; until then the project layer cannot define mappings at all.
  delete clamped.actorProfiles

  // enforcementMode: project cannot enable OR disable enforcement — only
  // global/inline can. A project "enforce" is deleted (can't enable), and a
  // project "observe" when the trusted baseline is "enforce" is also deleted
  // (can't downgrade from a global enforcement setting).
  if (clamped.enforcementMode !== undefined) {
    if (clamped.enforcementMode === "enforce" || trusted.enforcementMode === "enforce") {
      delete clamped.enforcementMode
    }
  }

  // riskPolicy.allow: project can narrow cells but not widen them.
  if (typeof clamped.riskPolicy === "object" && clamped.riskPolicy !== null) {
    const trustedPolicy =
      typeof trusted.riskPolicy === "object" && trusted.riskPolicy !== null
        ? (trusted.riskPolicy as Record<string, unknown>)
        : (DEFAULT_RISK_POLICY as unknown as Record<string, unknown>)
    clamped.riskPolicy = clampRiskPolicy(
      clamped.riskPolicy as Record<string, unknown>,
      trustedPolicy,
    )
  }

  // policyRules: the project layer ADDS rules (which can only tighten — its
  // allow rules are filtered by the engine), it never erases trusted
  // global/inline deny/manual rules. Combine instead of replace so a repo
  // cannot weaken policy by declaring an empty or narrower rule set. Project
  // rules are also re-tagged source:"project" so they cannot spoof
  // source:"inline" to bypass the project-allow filter.
  if (Array.isArray(clamped.policyRules)) {
    const projectRules = (clamped.policyRules as Array<Record<string, unknown>>).map((rule) => ({
      ...rule,
      source: "project" as PolicyRule["source"],
    }))
    const trustedRules = Array.isArray(trusted.policyRules) ? trusted.policyRules : []
    clamped.policyRules = [...trustedRules, ...projectRules]
  } else if (Array.isArray(trusted.policyRules)) {
    // Project omitted policyRules entirely: preserve the trusted rules.
    clamped.policyRules = trusted.policyRules
  }

  return { ...trusted, ...clamped }
}

/** Ensure project riskPolicy cells are subsets of the trusted baseline (project
 *  can remove authorizations from a cell but never add them). */
function clampRiskPolicy(
  project: Record<string, unknown>,
  trusted: Record<string, unknown>,
): Record<string, unknown> {
  const projectAllow =
    typeof project.allow === "object" && project.allow !== null
      ? (project.allow as Record<string, unknown>)
      : {}
  const trustedAllow =
    typeof trusted.allow === "object" && trusted.allow !== null
      ? (trusted.allow as Record<string, unknown>)
      : {}
  const clampedAllow: Record<string, unknown> = {}
  for (const risk of ["low", "medium", "high", "critical"] as const) {
    const trustedCell = Array.isArray(trustedAllow[risk]) ? (trustedAllow[risk] as unknown[]) : []
    const projectCell = Array.isArray(projectAllow[risk]) ? (projectAllow[risk] as unknown[]) : []
    // Intersection: project can only remove, never add.
    clampedAllow[risk] = trustedCell.filter((auth) => projectCell.includes(auth))
  }
  return { ...project, allow: clampedAllow }
}
