import { EventEmitter } from "events"
import { EventGateway } from "@/server/event"

type Input = EventGateway.Input | EventGateway.Envelope

const bus = new EventEmitter<{
  event: [EventGateway.Envelope]
}>()

export const GlobalBus = {
  emit(name: "event", input: Input) {
    const event = "sequence" in input ? input : EventGateway.record(input)
    return bus.emit(name, event)
  },

  on<T = EventGateway.Envelope>(name: "event", listener: (event: T) => void) {
    bus.on(name, listener as (event: EventGateway.Envelope) => void)
    return this
  },

  off<T = EventGateway.Envelope>(name: "event", listener: (event: T) => void) {
    bus.off(name, listener as (event: EventGateway.Envelope) => void)
    return this
  },
}
