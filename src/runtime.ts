// Compatibility facade.
//
// The review lifecycle now lives in ./core/review-coordinator.ts
// (ReviewCoordinator), the OpenCode transport wiring in ./opencode/, and event
// normalization in ./opencode/event-normalizer.ts. This module re-exports the
// previous public surface under the historical names so existing consumers
// (tests/helpers.ts, runtime.test.ts, index.ts, tui.tsx) keep compiling through
// the prerelease cycle. New code should import from the canonical modules.

export { ReviewCoordinator as ApprovalReviewerRuntime } from "./core/review-coordinator.ts"
export type { ClientResponse, OpenCodeClientLike, RuntimeContext } from "./opencode/types.ts"
export { extractPermissionRequest } from "./opencode/event-normalizer.ts"
