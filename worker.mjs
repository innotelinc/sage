/**
 * Cloudflare Worker entry (Sites). Serves /api/* through the shared handler and
 * everything else from the bound ASSETS directory.
 */
import { handleRequest } from './src/app.mjs';

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
