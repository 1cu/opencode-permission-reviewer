import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { DEFAULT_CONFIG, resolveConfig } from "./config.ts"
import { extractPermissionRequest } from "./runtime.ts"
import { decodeUiStatus, type ReviewUiStatus } from "./ui-protocol.ts"
import { ReviewUiState } from "./ui-state.ts"

const SPINNER = ["◐", "◓", "◑", "◒"] as const
const REVIEW_MODE = "permission-reviewer"

function routeSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return
  const params = "params" in route ? route.params : undefined
  const sessionID = params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function parentSessionID(api: TuiPluginApi, sessionID: string): string | undefined {
  return api.state.session.get(sessionID)?.parentID
}

function notifyManual(api: TuiPluginApi, status: ReviewUiStatus): void {
  api.ui.toast({
    variant: "warning",
    title: "Manual review required",
    message: status.reason ?? "The reviewer could not decide. This permission now needs your approval.",
    duration: 8_000,
  })
}

function ReviewPanel(props: {
  api: TuiPluginApi
  status: ReviewUiStatus
  frame: number
  elapsedMs: number
}) {
  const theme = () => props.api.theme.current
  const appearance = () => {
    if (props.status.phase === "approved") {
      return { color: theme().success, icon: "✓", title: "Review approved" }
    }
    if (props.status.phase === "denied") {
      return { color: theme().error, icon: "✕", title: "Review blocked" }
    }
    return {
      color: theme().info,
      icon: SPINNER[props.frame % SPINNER.length] ?? "◐",
      title: "Reviewing this permission",
    }
  }
  const elapsed = () => `${(props.elapsedMs / 1_000).toFixed(1)}s`

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={0}
      height="auto"
      maxHeight={12}
      overflow="hidden"
      backgroundColor={theme().backgroundPanel}
      border={["left"]}
      borderColor={appearance().color}
      flexDirection="column"
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onMouseUp={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <box
        flexDirection="column"
        gap={1}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={3}
      >
        <box flexDirection="row" gap={1}>
          <text fg={appearance().color}>{appearance().icon}</text>
          <text fg={theme().text}>{appearance().title}</text>
          <box flexGrow={1} />
          <text fg={theme().textMuted}>{elapsed()}</text>
        </box>

        <box flexDirection="row" gap={1} paddingLeft={2}>
          <text fg={theme().textMuted}>{props.status.permission}</text>
          <text fg={theme().text} wrapMode="word">
            {props.status.action}
          </text>
        </box>

        <Show when={props.status.phase === "reviewing"}>
          <box paddingLeft={2} flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>
              {props.status.model} · reasoning {props.status.variant}
            </text>
            <box flexGrow={1} />
            <text fg={theme().textMuted}>No action needed</text>
          </box>
        </Show>

        <Show when={props.status.phase !== "reviewing" && props.status.reason}>
          <box paddingLeft={2}>
            <text fg={theme().textMuted} wrapMode="word">
              {props.status.reason}
            </text>
          </box>
        </Show>
      </box>
    </box>
  )
}

function Overlay(props: { api: TuiPluginApi; state: ReviewUiState }) {
  const [revision, setRevision] = createSignal(0)
  const [frame, setFrame] = createSignal(0)

  const touch = () => setRevision((value) => value + 1)
  const active = () => {
    revision()
    const sessionID = routeSessionID(props.api)
    if (!sessionID) return
    return props.state.activeFor(sessionID, (id) => parentSessionID(props.api, id))
  }
  const elapsedMs = () => {
    frame()
    const status = active()
    return status ? Math.max(0, Date.now() - status.emittedAt) : 0
  }

  const onStatus = (status: ReviewUiStatus) => {
    if (!props.state.apply(status)) return
    if (status.phase === "manual") notifyManual(props.api, status)
    touch()
  }

  const offAsked = props.api.event.on("permission.asked", (event) => {
    const request = extractPermissionRequest(event)
    if (!request) return
    props.state.asked(request)
    touch()
  })
  const offReplied = props.api.event.on("permission.replied", (event) => {
    props.state.replied(event.properties.requestID)
    touch()
  })
  const offCommand = props.api.event.on("tui.command.execute", (event) => {
    const status = decodeUiStatus(event.properties.command)
    if (status) onStatus(status)
  })

  const ticker = setInterval(() => {
    setFrame((value) => (value + 1) % SPINNER.length)
    const expired = props.state.expire()
    for (const status of expired) notifyManual(props.api, status)
    const dismissed = props.state.dismissResults()
    if (expired.length > 0 || dismissed.length > 0) touch()
  }, 250)

  createEffect(() => {
    const status = active()
    if (!status || status.phase === "manual") return
    const pop = props.api.mode.push(REVIEW_MODE)
    onCleanup(pop)
  })

  onCleanup(() => {
    offAsked()
    offReplied()
    offCommand()
    clearInterval(ticker)
  })

  return (
    <Show when={active()} keyed>
      {(status) => (
        <Show when={status.phase !== "manual"}>
          <ReviewPanel api={props.api} status={status} frame={frame()} elapsedMs={elapsedMs()} />
        </Show>
      )}
    </Show>
  )
}

export const tui: TuiPlugin = async (api, options) => {
  const config = resolveConfig(options)
  const state = new ReviewUiState({
    model: config.model,
    variant: config.variant,
    timeoutMs: config.timeoutMs,
  })

  api.slots.register({
    order: 1_000,
    slots: {
      app() {
        return <Overlay api={api} state={state} />
      },
    },
  })
}

const module: TuiPluginModule = {
  id: "opencode-permission-reviewer",
  tui,
}

export default module
export { ReviewUiState, decodeUiStatus, DEFAULT_CONFIG }
