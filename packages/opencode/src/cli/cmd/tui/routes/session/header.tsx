import { type Accessor, createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { pipe, sumBy } from "remeda"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import type { AssistantMessage, Session, SessionStatus } from "@open-agent-harness/sdk/v2"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { useTerminalDimensions } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { createColors, createFrames } from "../../ui/spinner"
import { HeaderStatus } from "./header-status"
import { WorkflowProgress } from "./workflow-progress"

const Title = (props: { session: Accessor<Session> }) => {
  const { theme } = useTheme()
  return (
    <text fg={theme.text}>
      <span style={{ bold: true }}>#</span> <span style={{ bold: true }}>{props.session().title}</span>
    </text>
  )
}

const ContextInfo = (props: { context: Accessor<string | undefined>; cost: Accessor<string> }) => {
  const { theme } = useTheme()
  return (
    <Show when={props.context()}>
      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
        {props.context()} ({props.cost()})
      </text>
    </Show>
  )
}

const AgentInfo = (props: { agentName: Accessor<string | undefined>; agentColor: Accessor<RGBA> }) => {
  const { theme } = useTheme()
  return (
    <Show when={props.agentName()}>
      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
        <text fg={props.agentColor()}>●</text> {props.agentName()}
      </text>
    </Show>
  )
}

const WorkflowInfo = (props: { label: Accessor<string | undefined> }) => {
  const { theme } = useTheme()
  return (
    <Show when={props.label()}>
      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
        {props.label()}
      </text>
    </Show>
  )
}

const SessionStatusIndicator = (props: { status: Accessor<SessionStatus> }) => {
  const { theme } = useTheme()
  const local = useLocal()

  const spinnerDef = createMemo(() => {
    const color = local.agent.color(local.agent.current().name)
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
    }
  })

  const statusInfo = createMemo(() => {
    const s = props.status()
    switch (s.type) {
      case "idle":
        return { icon: "●", color: theme.success, label: "ready" }
      case "running":
        return { icon: null, color: local.agent.color(local.agent.current().name), label: "thinking" }
      case "waiting_permission":
        return { icon: "△", color: theme.warning, label: "awaiting permission" }
      case "waiting_user":
        return { icon: "⋯", color: theme.primary, label: "waiting for input" }
      case "error":
        return { icon: "✗", color: theme.error, label: "error" }
      case "retry":
        return { icon: "↻", color: theme.warning, label: `retry #${s.attempt}` }
      default:
        return { icon: "●", color: theme.textMuted, label: "unknown" }
    }
  })

  return (
    <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
      <Switch>
        <Match when={props.status().type === "running"}>
          <box flexDirection="row" gap={1} alignItems="center">
            <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={80} />
            <text fg={theme.textMuted}>thinking</text>
          </box>
        </Match>
        <Match when={true}>
          <text fg={statusInfo().color}>
            <text>{statusInfo().icon}</text>{" "}
            <text fg={theme.textMuted}>{statusInfo().label}</text>
          </text>
        </Match>
      </Switch>
    </text>
  )
}

export function Header() {
  const route = useRouteData("session")
  const sync = useSync()
  const session = createMemo(() => sync.session.get(route.sessionID)!)
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const sessionStatus = createMemo(() => sync.data.session_status[route.sessionID] ?? { type: "idle" as const })
  const status = createMemo(() =>
    HeaderStatus.resolve({
      current: sessionStatus(),
      route: session(),
      sessions: sync.data.session,
      permission: sync.data.permission,
      question: sync.data.question,
    }),
  )

  const cost = createMemo(() => {
    const total = pipe(
      messages(),
      sumBy((x) => (x.role === "assistant" ? x.cost : 0)),
    )
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(total)
  })

  const context = createMemo(() => {
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    let result = total.toLocaleString()
    if (model?.limit.context) {
      result += "  " + Math.round((total / model.limit.context) * 100) + "%"
    }
    return result
  })

  const local = useLocal()
  const currentAgentName = createMemo(() => local.agent.current()?.name)
  const currentAgentColor = createMemo(() => {
    const name = currentAgentName()
    if (!name) return RGBA.fromInts(128, 128, 128, 255)
    return local.agent.color(name)
  })
  const workflow = createMemo(() => WorkflowProgress.label(session()?.dsl_context))

  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <Switch>
          <Match when={session()?.parentID}>
            <box flexDirection="column" gap={1}>
              <box flexDirection={narrow() ? "column" : "row"} justifyContent="space-between" gap={narrow() ? 1 : 0}>
                <text fg={theme.text}>
                  <b>Subagent session</b>
                </text>

                <ContextInfo context={context} cost={cost} />
              </box>
              <box flexDirection="row" gap={2}>
                <AgentInfo agentName={currentAgentName} agentColor={currentAgentColor} />
                <SessionStatusIndicator status={status} />
                <WorkflowInfo label={workflow} />
                <box
                  onMouseOver={() => setHover("parent")}
                  onMouseOut={() => setHover(null)}
                  onMouseUp={() => command.trigger("session.parent")}
                  backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
                >
                  <text fg={theme.text}>
                    Parent <span style={{ fg: theme.textMuted }}>{keybind.print("session_parent")}</span>
                  </text>
                </box>
                <box
                  onMouseOver={() => setHover("prev")}
                  onMouseOut={() => setHover(null)}
                  onMouseUp={() => command.trigger("session.child.previous")}
                  backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
                >
                  <text fg={theme.text}>
                    Prev <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle_reverse")}</span>
                  </text>
                </box>
                <box
                  onMouseOver={() => setHover("next")}
                  onMouseOut={() => setHover(null)}
                  onMouseUp={() => command.trigger("session.child.next")}
                  backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
                >
                  <text fg={theme.text}>
                    Next <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle")}</span>
                  </text>
                </box>
              </box>
            </box>
          </Match>
          <Match when={true}>
            <box flexDirection={narrow() ? "column" : "row"} justifyContent="space-between" gap={1}>
              <box flexDirection="row" gap={2}>
                <Title session={session} />
                <AgentInfo agentName={currentAgentName} agentColor={currentAgentColor} />
                <SessionStatusIndicator status={status} />
                <WorkflowInfo label={workflow} />
              </box>
              <ContextInfo context={context} cost={cost} />
            </box>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
