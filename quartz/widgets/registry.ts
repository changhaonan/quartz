import type { Widget } from "./types"

const registry = new Map<string, Widget>()

export function registerWidget<T>(widget: Widget<T>): void {
  if (registry.has(widget.type)) {
    console.warn(`[widget] re-registering "${widget.type}"`)
  }
  registry.set(widget.type, widget as Widget)
}

export function getWidget(type: string): Widget | undefined {
  return registry.get(type)
}

export function listWidgets(): Widget[] {
  return Array.from(registry.values())
}
