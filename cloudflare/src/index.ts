import { handleLure, isLureRequest } from "./lures";

export interface Env {
  ORIGIN: {
    fetch(request: Request): Promise<Response>;
  };
  LURE_KEY_SECRET?: string;
  BAIT_API_PATH?: string;
  ALLOWLISTED_SOURCES?: string;
  ALERT_DIRECT_LURE?: string;
  ALERT_CONFIRMATION?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (isLureRequest(request, env)) {
      const result = await handleLure(request, env);
      return result.response;
    }
    return env.ORIGIN.fetch(request);
  },
};
