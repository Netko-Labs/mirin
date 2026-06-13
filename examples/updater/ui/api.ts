import { client } from "mirinjs/client";
import type { Router } from "../main/rpc.ts";

export const api = client<Router>();
