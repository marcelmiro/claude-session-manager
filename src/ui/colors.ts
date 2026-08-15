export const C = {
  bg: "#101010",
  // Blessed has a stale lookup-cache entry for exact #FFFFFF and maps it to
  // ANSI white (7), which Vesper deliberately defines as muted #A0A0A0.
  // A one-step-off request resolves to bright white (15), whose Vesper palette
  // entry is the intended #FFFFFF.
  fg: "#FEFEFE",
  muted: "#A0A0A0",
  dim: "#505050",
  surface: "#1C1C1C",
  hover: "#282828",
  peach: "#FFC799",
  mint: "#99FFE4",
  red: "#FF8080",
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
