export const C = {
  // Use the terminal's ANSI slots for the base palette. Ghostty maps these to
  // the exact Vesper colors; named slots also avoid Blessed's lossy RGB→256
  // conversion and make the UI follow another terminal theme coherently.
  bg: "black",
  fg: "bright-white",
  muted: "white",
  dim: "bright-black",
  surface: "#1C1C1C",
  hover: "#282828",
  peach: "bright-yellow",
  mint: "bright-green",
  red: "bright-red",
} as const;

export function statusColor(status: "running" | "waiting" | "ready" | "idle" | "archived"): string {
  switch (status) {
    case "running":
      return C.mint;
    case "waiting":
      return C.red;
    case "ready":
      return C.peach;
    case "idle":
    case "archived":
      return C.dim;
  }
}

export function statusDot(status: "running" | "waiting" | "ready" | "idle" | "archived"): string {
  switch (status) {
    case "waiting":
      return "⏸";
    case "running":
      return "⦿";
    case "ready":
      return "●";
    case "idle":
    case "archived":
      return "○";
  }
}
