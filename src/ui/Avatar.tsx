import { useStore } from '../store'

/**
 * Kumari's portrait, from the original desktop avatar overlay. A ring around
 * it shows what she is doing — the same states the old overlay used (grey
 * idle, blue listening, orange thinking, green speaking) — and she sways a
 * little while talking, driven by the same level the reactor uses.
 */
const RING: Record<string, string> = {
  offline: '#5d6b75',
  boot: '#5d6b75',
  dormant: '#5d6b75',
  waking: '#35b6ff',
  listening: '#35b6ff',
  thinking: '#ff9f2e',
  tooling: '#ff9f2e',
  speaking: '#2ee67a',
}

export function Avatar() {
  const phase = useStore((s) => s.phase)
  const level = useStore((s) => s.level)
  if (phase === 'offline' || phase === 'boot') return null

  const speaking = phase === 'speaking'
  const ring = RING[phase] ?? RING.dormant
  const bob = speaking ? Math.min(1, level * 1.6) * 5 : 0

  return (
    <div className="avatar" aria-hidden="true">
      <div
        className="avatar-ring"
        style={{
          borderColor: ring,
          boxShadow: `0 0 ${14 + level * 26}px ${ring}66, inset 0 0 18px ${ring}33`,
        }}
      >
        <img
          src="/kumari.png"
          alt=""
          draggable={false}
          style={{ transform: `translateY(${-bob}px) scale(${1 + (speaking ? level * 0.03 : 0)})` }}
        />
      </div>
    </div>
  )
}
