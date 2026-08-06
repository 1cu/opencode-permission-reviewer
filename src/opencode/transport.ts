import type { ClientResponse } from "./types.ts"

export function responseData<T>(response: ClientResponse<T>, label: string): T {
  if (response.error !== undefined)
    throw new Error(`${label} failed: ${JSON.stringify(response.error)}`)
  if (response.data === undefined) throw new Error(`${label} returned no data`)
  return response.data
}

export function extractStructured(response: Record<string, unknown>): unknown {
  const info = response.info
  if (typeof info !== "object" || info === null) return
  return (info as Record<string, unknown>).structured
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Reviewer timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * Recognize the error shape OpenCode returns when a permission reply arrives
 * for a request that was already resolved (first-writer-wins). The server's
 * `PermissionNotFoundError` is HTTP 404; the raw SDK may surface it as a status
 * code, an error code, or a human-readable message.
 */
export function isAlreadyResolvedError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false
  const record = error as Record<string, unknown>
  const status = record.status
  if (status === 404 || status === "404") return true
  const code = typeof record.code === "string" ? record.code : ""
  if (/PermissionNotFound|not_found|notfound|already_resolved/i.test(code)) return true
  const message = typeof record.message === "string" ? record.message : ""
  // No `\b` so camelCase "PermissionNotFoundError" and "notfound" still match.
  return /PermissionNotFound|not\s*found|no\s+longer\s+(?:pending|exist)s?|already\s+(?:been\s+)?(?:resolved|answered|replied|closed)/i.test(
    message,
  )
}
