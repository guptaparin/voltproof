/** @type {import('next').NextConfig} */
const staticDemo = process.env.NEXT_PUBLIC_STATIC_DEMO === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export default {
  reactStrictMode: true,
  // `npm run build:demo` produces a fully static site (out/) for GitHub Pages / Vercel.
  ...(staticDemo ? { distDir: "demo-site", output: "export", trailingSlash: true, images: { unoptimized: true }, basePath: basePath || undefined } : {}),
};
