import { app } from "mirinjs";
import { router } from "./rpc.ts";

// Serve the RPC router; the "glass" window auto-opens from the manifest.
app.serve(router);
