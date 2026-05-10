import type { z, ZodType } from "zod"

export type WidgetMode = "readonly" | "live"

export interface WidgetCapabilities {
  canWrite: boolean
  bridgeOrigin: string
  workspaceId: string | null
}

export type JsonPatchOp =
  | { op: "replace"; path: string; value: unknown }
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "move"; path: string; from: string }
  | { op: "copy"; path: string; from: string }
  | { op: "test"; path: string; value: unknown }

export interface WidgetWriteRequest {
  workspaceId: string
  path: string
  patch: JsonPatchOp[]
  ifVersion?: string | number
}

export interface WidgetWriteResult {
  ok: boolean
  newVersion?: string | number
  data?: unknown
  error?: { code: string; message: string }
}

export interface WidgetWriteCall {
  patch: JsonPatchOp[]
  ifVersion?: string | number
}

export interface WidgetMountContext<T> {
  el: HTMLElement
  data: T
  mode: WidgetMode
  capabilities: WidgetCapabilities
  write: (req: WidgetWriteCall) => Promise<WidgetWriteResult>
  refresh: () => Promise<void>
}

export type WidgetDispose = () => void

export interface Widget<T = unknown> {
  type: string
  schemaVersion: number
  schema: ZodType<T>
  mount(ctx: WidgetMountContext<T>): WidgetDispose | void
}

export type InferWidgetData<W> = W extends Widget<infer T> ? T : never

export type ZodInfer<S extends ZodType<any>> = z.infer<S>
