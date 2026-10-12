import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

/**
 * A text box for when you would rather type, or the microphone is not
 * available (a quiet library, a missing permission). Whatever is typed becomes
 * a turn exactly as if it had been spoken.
 *
 * Press "/" anywhere to focus it. Escape leaves it. It only appears once
 * Kumari is powered on.
 */
export function CommandBar({ onSend }: { onSend: (text: string) => void }) {
  const phase = useStore((s) => s.phase)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== input.current && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (phase === 'offline' || phase === 'boot') return null

  return (
    <form
      className="command-bar"
      onSubmit={(e) => {
        e.preventDefault()
        const t = text.trim()
        if (!t) return
        onSend(t)
        setText('')
      }}
    >
      <input
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') input.current?.blur()
          e.stopPropagation() // keep Space, V, L, G, T for typing, not shortcuts
        }}
        placeholder="Type to Kumari…   ( / )"
        autoComplete="off"
        spellCheck={false}
        aria-label="Type a message to Kumari"
      />
      <button type="submit" aria-label="Send" disabled={!text.trim()}>
        ↵
      </button>
    </form>
  )
}
