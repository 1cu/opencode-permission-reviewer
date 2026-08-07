// Compatibility facade.
//
// The review lifecycle lives in ./core/review-coordinator.ts
// (ReviewCoordinator), the OpenCode transport wiring in ./opencode/, and event
// normalization in ./opencode/event-normalizer.ts. This module re-exports the
// previous public surface under the historical names so existing consumers
// (tests/helpers.ts, tests/runtime.test.ts, src/index.ts) keep compiling.
// New code should import from the canonical modules. The TUI entry imports
// extractPermissionRequest from ./opencode/event-normalizer.ts directly so it
// never evaluates the server engine.

export { ReviewCoordinator as ApprovalReviewerRuntime } from "./core/review-coordinator.ts"
export type { ClientResponse, OpenCodeClientLike, RuntimeContext } from "./opencode/types.ts"
export { extractPermissionRequest } from "./opencode/event-normalizer.ts"
