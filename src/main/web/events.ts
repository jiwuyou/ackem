import type { AckemWebEvent } from '../../shared/webTransport'
import type { WebEventListener, WebEventSink } from './types'

export class AckemWebEventBus {
  private listeners = new Set<WebEventListener>()

  subscribe(listener: WebEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(channel: string, payload: unknown): AckemWebEvent {
    const event: AckemWebEvent = {
      channel,
      payload,
      ts: Date.now(),
      source: 'main',
    }

    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* isolate event subscribers */
      }
    }

    return event
  }

  listenerCount(): number {
    return this.listeners.size
  }
}

export function createWebEventSink(eventBus: { emit: (channel: string, payload: unknown) => unknown }): WebEventSink {
  return {
    send: (channel: string, payload: unknown) => {
      eventBus.emit(channel, payload)
    },
  }
}

export const defaultWebEventBus = new AckemWebEventBus()
export const defaultWebEventSink = createWebEventSink(defaultWebEventBus)
