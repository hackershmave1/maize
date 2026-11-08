export interface Env {
  ORIGIN: {
    fetch(request: Request): Promise<Response>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return env.ORIGIN.fetch(request);
  },
};
