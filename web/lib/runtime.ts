/** Static live-demo build: the whole app runs in the browser from a snapshot of a real run. */
export const STATIC_DEMO = process.env.NEXT_PUBLIC_STATIC_DEMO === "1";
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
