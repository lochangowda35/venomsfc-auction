export class ApiError extends Error {
  status: number
  fields: Record<string, string>

  constructor(message: string, status: number, fields: Record<string, string> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.fields = fields
  }
}

export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; csrf?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timeout = window.setTimeout(abort, 7000)
  const headers: Record<string, string> = {}
  const multipart = options.body instanceof FormData
  if (options.body !== undefined && !multipart) headers['Content-Type'] = 'application/json'
  if (options.csrf) headers['X-CSRF-Token'] = options.csrf
  try {
    const response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      body: options.body === undefined ? undefined : multipart
        ? options.body as FormData : JSON.stringify(options.body),
      signal: controller.signal,
    })
    const data = await response.json().catch((error: unknown) => {
      if (controller.signal.aborted) throw error
      return null
    })
    if (!response.ok) {
      throw new ApiError(data?.error ?? `Request failed (HTTP ${response.status}).`, response.status, data?.fields)
    }
    if (data === null) throw new ApiError('The server returned an invalid response. Refresh before continuing.', 502)
    return data as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(
      controller.signal.aborted
        ? 'The server did not respond in time.'
        : 'Cannot reach the local auction server.',
      0,
    )
  } finally {
    window.clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
