/**
 * Tool plumbing.
 *
 * The original Kumari defined its tools with the Claude Agent SDK's `tool()` and
 * `createSdkMcpServer()`. That SDK only runs against a Claude Code login, which
 * is exactly the dependency Kumari removes. These two functions keep the same
 * call shape, so panels.mjs / ui.mjs / vision.mjs work untouched, but they just
 * produce plain descriptors that any LLM provider can use:
 *
 *   { name, description, parameters (JSON schema), run(args) -> MCP-style result }
 *
 * A handler returns `{ content: [{type:'text'|'image', ...}], isError? }`, the
 * same shape as before.
 */

import { z } from 'zod'

/** Collapse whatever zod emits into the small JSON-schema subset every provider accepts. */
export function cleanSchema(node, jsonKeys = [], path = '') {
  if (Array.isArray(node)) return node.map((n) => cleanSchema(n, jsonKeys, path))
  if (!node || typeof node !== 'object') return node

  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (
      [
        '$schema', 'additionalProperties', 'propertyNames', 'default', 'examples',
        'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern',
        'format', 'patternProperties', '$id', '$defs', 'const',
      ].includes(key)
    ) {
      continue
    }
    out[key] = value
  }

  // z.union([z.number(), z.string()]) arrives as type: ['number','string'].
  // Providers want one type. 'string' is the permissive choice, and every
  // handler already coerces loosely.
  if (Array.isArray(out.type)) {
    const real = out.type.filter((t) => t !== 'null')
    out.type = real.includes('string') ? 'string' : (real[0] ?? 'string')
  }

  for (const combiner of ['anyOf', 'oneOf']) {
    if (Array.isArray(out[combiner])) {
      const variants = out[combiner].filter((v) => v && v.type !== 'null')
      const picked =
        variants.find((v) => v.type === 'string') ?? variants[0] ?? { type: 'string' }
      delete out[combiner]
      Object.assign(out, cleanSchema(picked, jsonKeys, path))
    }
  }

  if (out.properties && typeof out.properties === 'object') {
    const props = {}
    for (const [k, v] of Object.entries(out.properties)) {
      props[k] = cleanSchema(v, jsonKeys, path ? `${path}.${k}` : k)
    }
    out.properties = props
  }
  if (out.items) out.items = cleanSchema(out.items, jsonKeys, path)

  // A free-form object (z.record) has no properties, and Gemini rejects those
  // outright. Offer it as a JSON string and parse it back before validation.
  if (out.type === 'object' && (!out.properties || !Object.keys(out.properties).length)) {
    out.type = 'string'
    out.description = `${out.description ?? ''} Give this as a JSON-encoded object string.`.trim()
    delete out.properties
    delete out.required
    if (path) jsonKeys.push(path)
  }

  if (Array.isArray(out.required) && out.required.length === 0) delete out.required
  return out
}

/** Build the tool descriptor. Same signature as the SDK's `tool()`. */
export function tool(name, description, shape, handler) {
  const object = z.object(shape ?? {})
  const jsonKeys = []
  const raw = z.toJSONSchema(object, { io: 'input', unrepresentable: 'any' })
  const parameters = cleanSchema(raw, jsonKeys)
  if (!parameters.type) parameters.type = 'object'
  if (!parameters.properties) parameters.properties = {}

  return {
    name,
    description: String(description ?? '').trim(),
    parameters,
    async run(rawArgs) {
      const args = { ...(rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) }
      for (const key of jsonKeys) {
        if (typeof args[key] === 'string') {
          try {
            args[key] = JSON.parse(args[key])
          } catch {
            delete args[key]
          }
        }
      }
      // Loose parse: every schema in this codebase is written to be forgiving,
      // and a model sending a number as a string must never fail a turn.
      const parsed = object.safeParse(args)
      return handler(parsed.success ? parsed.data : args)
    },
  }
}

/** Same signature as the SDK's `createSdkMcpServer()`; here it is just a named bag of tools. */
export function createSdkMcpServer({ name, tools, instructions }) {
  return { name, instructions, tools }
}

/** Shorthand for results. */
export const textResult = (text) => ({ content: [{ type: 'text', text: String(text) }] })
export const errorResult = (text) => ({
  isError: true,
  content: [{ type: 'text', text: String(text) }],
})
