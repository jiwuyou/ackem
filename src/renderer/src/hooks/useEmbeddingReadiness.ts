import { useEffect, useState } from 'react'
import {
  isEmbeddingReadyForChat,
  type EmbeddingReadinessSnapshot,
} from '../lib/chatSend'
import { ackemClient } from '../api'

function readinessErrorSnapshot(error: unknown): EmbeddingReadinessSnapshot {
  return {
    phase: 'idle',
    progress: 0,
    providerReady: false,
    factEmbeddingsReady: false,
    preLlmWarmReady: false,
    error: error instanceof Error ? error.message : String(error)
  }
}

export function useEmbeddingReadiness() {
  const [embeddingReadiness, setEmbeddingReadiness] = useState<EmbeddingReadinessSnapshot | null>(
    null
  )

  useEffect(() => {
    let unsub: (() => void) | undefined
    void (async () => {
      try {
        const snap = await ackemClient.embeddingReadiness()
        setEmbeddingReadiness(snap as EmbeddingReadinessSnapshot)
      } catch (e) {
        setEmbeddingReadiness(readinessErrorSnapshot(e))
      }
      unsub = ackemClient.onEmbeddingReadinessChanged((snap) => {
        setEmbeddingReadiness(snap as EmbeddingReadinessSnapshot)
      }) ?? undefined
    })()
    return () => unsub?.()
  }, [])

  return {
    embeddingReadiness,
    embeddingChatReady: isEmbeddingReadyForChat(embeddingReadiness),
    showEmbeddingBanner:
      embeddingReadiness != null &&
      embeddingReadiness.phase !== 'ready' &&
      embeddingReadiness.phase !== 'degraded',
  }
}
