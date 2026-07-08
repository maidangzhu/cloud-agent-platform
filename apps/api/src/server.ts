import { handle } from "hono/vercel";
import { createApp } from "./app.js";

// Vercel Hono entrypoint. Local development keeps using src/index.ts with
// @hono/node-server; Vercel invokes this hosted fetch handler.
const handler = handle(createApp());

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
