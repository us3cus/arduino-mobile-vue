type BackendFetchError = {
  statusCode?: number;
  statusMessage?: string;
  message?: string;
  data?: unknown;
  response?: {
    status?: number;
    statusText?: string;
  };
};

export async function callBackend<TResponse>(
  event: Parameters<typeof useRuntimeConfig>[0],
  path: string,
  options: Parameters<typeof $fetch<TResponse>>[1] = {},
): Promise<TResponse> {
  const config = useRuntimeConfig(event);
  const baseUrl = String(config.backendBase ?? 'http://127.0.0.1:3000').replace(
    /\/$/,
    '',
  );

  try {
    return await $fetch<TResponse>(`${baseUrl}${path}`, options);
  } catch (error) {
    const fetchError = error as BackendFetchError;

    throw createError({
      statusCode: fetchError.statusCode ?? fetchError.response?.status ?? 500,
      statusMessage:
        fetchError.statusMessage ??
        fetchError.response?.statusText ??
        fetchError.message ??
        'Backend request failed',
      data: fetchError.data ?? null,
    });
  }
}
