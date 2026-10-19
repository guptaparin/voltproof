import type { Config } from "tailwindcss";

const v = (n: string) => `rgb(var(--${n}) / <alpha-value>)`;

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: v("paper"),
        panel: v("panel"),
        ink: v("ink"),
        muted: v("muted"),
        rule: v("rule"),
        sun: v("sun"),
        sunink: v("sunink"),
        ceiling: v("ceiling"),
        reject: v("reject"),
        held: v("held"),
        ok: v("ok"),
      },
      fontFamily: { sans: ["Archivo Variable", "Archivo", "system-ui", "sans-serif"] },
    },
  },
  plugins: [],
} satisfies Config;
