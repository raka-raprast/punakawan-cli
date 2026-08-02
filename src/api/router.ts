import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const regex = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${regex}$`), keys };
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): void {
    const { regex, keys } = compile(pattern);
    this.routes.push({ method, regex, keys, handler });
  }

  get(pattern: string, handler: RouteHandler): void {
    this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: RouteHandler): void {
    this.add("POST", pattern, handler);
  }
  delete(pattern: string, handler: RouteHandler): void {
    this.add("DELETE", pattern, handler);
  }
  patch(pattern: string, handler: RouteHandler): void {
    this.add("PATCH", pattern, handler);
  }

  match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => (params[key] = decodeURIComponent(match[i + 1]!)));
      return { handler: route.handler, params };
    }
    return undefined;
  }
}
