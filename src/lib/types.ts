/** Handlers a turn reports into. */
export type AskHandlers = {
  /** Fires for each chunk of the spoken answer. */
  onText: (delta: string) => void
  /** Fires when a tool starts running. */
  onTool: (name: string) => void
}

/** Kept for the history plumbing in App.tsx; the bridge holds the real history. */
export type Msg = { role: 'user' | 'assistant'; content: string }
