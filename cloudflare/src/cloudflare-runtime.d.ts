declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    constructor(ctx: { storage: unknown }, env: Env);
  }
}

declare module "cloudflare:test" {
  export const env: unknown;
}
