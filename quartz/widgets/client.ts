import type { WidgetWriteRequest, WidgetWriteResult } from "./types"

export interface FetchedWidgetData {
  data: unknown
  version: string | null
}

export async function fetchWidgetData(src: string): Promise<FetchedWidgetData> {
  const res = await fetch(src, { cache: "no-cache" })
  if (!res.ok) {
    throw new Error(`widget data fetch failed: ${res.status} ${res.statusText}`)
  }
  const data = await res.json()
  // Don't read version from HTTP cache headers — Quartz's serve handler
  // emits Last-Modified as an HTTP date, but the write endpoint compares
  // against fs.mtimeMs (a numeric string). The first write therefore
  // skips the ifVersion check (server treats null as "no precondition")
  // and stores the canonical mtimeMs returned in the response. From then
  // on, every subsequent write uses the format the server actually emits.
  return { data, version: null }
}

export async function writeWidget(
  _bridgeOrigin: string,
  req: WidgetWriteRequest,
): Promise<WidgetWriteResult> {
  // Same-origin endpoint hosted by Quartz's dev server (quartz/cli/handlers.js).
  // Keeping the call same-origin avoids CORS and decouples the renderer
  // subsystem from the heavy bridge process (PTY/file-runtime/deploy state).
  // bridgeOrigin is kept in the signature for future reuse but unused here.
  const url = `/api/widget/write`
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    })
  } catch (e) {
    return {
      ok: false,
      error: { code: "network_error", message: (e as Error).message },
    }
  }
  if (!res.ok) {
    let serverError: { code: string; message: string } | undefined
    try {
      const parsed = (await res.json()) as WidgetWriteResult
      const err = parsed?.error
      if (err && typeof err.code === "string" && typeof err.message === "string") {
        serverError = { code: err.code, message: err.message }
      }
    } catch {}
    return {
      ok: false,
      error: serverError ?? {
        code: `http_${res.status}`,
        message: res.statusText || `request failed with status ${res.status}`,
      },
    }
  }
  try {
    return (await res.json()) as WidgetWriteResult
  } catch {
    return { ok: true }
  }
}
