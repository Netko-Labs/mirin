import { client } from "mirinjs/client";
import type { Router } from "../main/rpc.ts";

/** Typed RPC client — full inference from the main-process router, no codegen. */
export const api = client<Router>();
