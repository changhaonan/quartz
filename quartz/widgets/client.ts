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
  const version = res.headers.get("etag") ?? res.headers.get("last-modified")
  const data = await res.json()
  return { data, version }
}

export async function writeWidget(
  bridgeOrigin: string,
  req: WidgetWriteRequest,
): Promise<WidgetWriteResult> {
  let res: Response
  try {
    res = await fetch(`${bridgeOrigin.replace(/\/$/, "")}/api/file-runtime/write`, {
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
    return {
      ok: false,
      error: { code: `http_${res.status}`, message: res.statusText },
    }
  }
  try {
    return (await res.json()) as WidgetWriteResult
  } catch {
    return { ok: true }
  }
}
