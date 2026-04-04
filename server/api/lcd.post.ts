import { callBackend } from '../utils/backend';

export default defineEventHandler(
  async (event: Parameters<typeof callBackend>[0]) => {
    const body = await readBody<Record<string, unknown>>(event);

    return callBackend(event, '/api/lcd', {
      method: 'POST',
      body,
    });
  },
);
