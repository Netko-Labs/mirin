import { runtime } from "./runtime.ts";

export interface NotificationOptions {
  title: string;
  body?: string;
}

export const notification = {
  /** Ask the operating system to display a desktop notification. */
  show(options: NotificationOptions): boolean {
    const title = options.title.trim();
    if (!title || title.length > 128) return false;
    if (options.body && options.body.length > 512) return false;

    return runtime().core.notificationShow(
      JSON.stringify({ ...options, title, appName: runtime().id }),
    );
  },
};
