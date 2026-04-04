import { callBackend } from '../utils/backend';

export default defineEventHandler((event: Parameters<typeof callBackend>[0]) => {
  return callBackend(event, '/api/device/dht');
});
