import { QuartzTransformerPlugin } from "../types"

type FrameAttrs = {
  src?: string
  title?: string
  height?: string
  mode?: string
  note?: string
  width?: string
  chrome?: string
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function parseAttrs(raw: string): FrameAttrs {
  const attrs: FrameAttrs = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/)
    if (!match) continue
    const key = match[1] as keyof FrameAttrs
    const value = match[2].replace(/^['"]|['"]$/g, "")
    attrs[key] = value
  }
  return attrs
}

function normalizeHeight(value: string | undefined): string {
  if (!value) return "760px"
  if (/^\d+$/.test(value)) return `${value}px`
  if (/^\d+(px|vh|rem|em|%)$/.test(value)) return value
  return "760px"
}

function renderFrame(attrs: FrameAttrs): string {
  const src = attrs.src || "/"
  const title = attrs.title || "Bridge frame"
  const mode = attrs.mode || "readonly"
  const note = attrs.note || "Embedded bridge surface"
  const height = normalizeHeight(attrs.height)
  const width = attrs.width === "wide" || attrs.width === "full" ? attrs.width : "normal"
  const chrome = attrs.chrome === "compact" || attrs.chrome === "integrated" ? attrs.chrome : "default"

  return `<div class="bridge-frame-card" data-bridge-frame="${escapeHtml(mode)}" data-bridge-width="${escapeHtml(width)}" data-bridge-chrome="${escapeHtml(chrome)}" style="border:1px solid color-mix(in srgb, var(--lightgray) 82%, var(--secondary));border-radius:8px;overflow:hidden;margin:1rem 0 1.35rem;background:var(--light);box-shadow:0 8px 20px rgba(0,0,0,.055);">
  <div class="bridge-frame-header" style="display:flex;align-items:center;justify-content:space-between;gap:1rem;border-bottom:1px solid color-mix(in srgb, var(--lightgray) 84%, var(--secondary));padding:.5rem .75rem;background:color-mix(in srgb, var(--light) 94%, var(--secondary));">
    <div>
      <strong style="display:block;color:var(--dark);font-size:.94rem;line-height:1.2;">${escapeHtml(title)}</strong>
      <span style="display:block;color:var(--gray);font-size:.78rem;line-height:1.25;">${escapeHtml(note)}</span>
    </div>
    <a class="internal" href="${escapeHtml(src)}" target="_blank" rel="noreferrer" style="white-space:nowrap;font-size:.86rem;">Open live</a>
  </div>
  <iframe
    title="${escapeHtml(title)}"
    src="${escapeHtml(src)}"
    loading="lazy"
    referrerpolicy="no-referrer"
    sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
    style="display:block;width:100%;height:${escapeHtml(height)};border:0;background:#fffaf0;"
  ></iframe>
</div>`
}

export const BridgeFrame: QuartzTransformerPlugin = () => {
  return {
    name: "BridgeFrame",
    textTransform(_ctx, src) {
      return src.replace(/```bridge-frame\s*\n([\s\S]*?)```/g, (_match, raw) => {
        return renderFrame(parseAttrs(raw))
      })
    },
  }
}
