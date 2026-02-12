export const C = {
  bg: "#101010",
  fg: "#FFFFFF",
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
