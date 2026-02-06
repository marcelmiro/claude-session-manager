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

export function contextColor(percent: number): string {
  if (percent < 50) return C.mint;
  if (percent < 80) return C.peach;
  return C.red;
}

export function statusColor(status: "input" | "running" | "idle"): string {
  switch (status) {
    case "input":
      return C.peach;
    case "running":
      return C.mint;
    case "idle":
      return C.dim;
  }
}

export function statusDot(status: "input" | "running" | "idle"): string {
  switch (status) {
    case "input":
      return "●";
    case "running":
      return "◉";
    case "idle":
      return "○";
  }
}
