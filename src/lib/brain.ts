import * as bridge from './bridge'
import type { AskHandlers, Msg } from './types'
import type { Blade, Panel } from '../store'

export type { AskHandlers, Msg }
export type { ConnectionState } from './bridge'

/**
 * The brain is the local Kumari bridge (bridge/server.mjs): it holds the
 * conversation, the memory, the tools and the connection to whichever AI model
 * is configured. The browser is only the face and the voice.
 */

export const usingBridge = true

export async function ask(
  prompt: string,
  _history: Msg[],
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[] }> {
  return bridge.ask(prompt, handlers)
}

export async function warm(): Promise<void> {
  await bridge.warmBridge()
}

export function watchServers(fn: (servers: string[]) => void): void {
  bridge.watchServers(fn)
}

export function watchPanels(fn: (panel: Panel) => void): void {
  bridge.watchPanels(fn)
}

export function watchBlades(fn: (blade: Blade) => void): void {
  bridge.watchBlades(fn)
}

export function watchUi(fn: (op: string, args: any) => void): void {
  bridge.watchUi(fn)
}

export function watchCapture(
  fn: (req: bridge.CaptureRequest) => Promise<bridge.CaptureResult>,
): void {
  bridge.watchCapture(fn)
}

/** Reminders and timers that fire with nobody asking: the bridge pushes a line to speak. */
export function watchSay(fn: (text: string) => void): void {
  bridge.watchSay(fn)
}

/** Facts about the running bridge (assistant name, mic language, which AI is active). */
export function bridgeInfo(): bridge.BridgeInfo {
  return bridge.info()
}

export function cancel(): void {
  bridge.cancel()
}

export function interrupt(): void {
  cancel()
}

export function isConnected(): boolean {
  return bridge.isConnected()
}

export function watchConnection(
  fn: (state: bridge.ConnectionState) => void,
): void {
  bridge.watchConnection(fn)
}

export function connectedLabels(): string[] {
  return bridge.bridgeServers()
}
