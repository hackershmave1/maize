declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    constructor(ctx: { storage: unknown }, env: Env);
  }
}

declare module "cloudflare:test" {
  export const env: unknown;
  export function createExecutionContext(): {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  };
  export function waitOnExecutionContext(context: {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }): Promise<void>;
}

declare module "*?raw" {
  const content: string;
  export default content;
}
