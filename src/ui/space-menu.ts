/**
 * Space menu — neovim which-key style action overlay.
 * Renders a popup at bottom-left of the session list with contextual actions.
 */

import { C } from "./colors";
import { handleTextInputKey, renderTextWithCursor } from "./text-input";

export type SpaceMenuLevel = "root" | "send-message";

export interface SpaceMenuState {
  level: SpaceMenuLevel;
  /** Back target when exiting send-message */
  previousLevel?: SpaceMenuLevel;
  /** Text input state for send-message */
  messageText: string;
  messageCursor: number;
}

export type SpaceMenuAction =
  | { type: "noop" }
  | { type: "render" }
  | { type: "close" }
  | { type: "back" }
  | { type: "exec"; command: "copy" | "rename" | "kill" | "fork" }
  | { type: "send-keys"; keys: string[] }
  | { type: "send-text"; text: string }
  | { type: "start-input" };

// --- State lifecycle ---

export function createSpaceMenuState(): SpaceMenuState {
  return {
    level: "root",
    messageText: "",
    messageCursor: 0,
  };
}

// --- Rendering ---

function keyLabel(key: string, label: string): string {
  return `  {${C.peach}-fg}${key}{/${C.peach}-fg}  ${label}`;
}

function renderRoot(): string {
  return [
    keyLabel("m", "send message"),
    keyLabel("c", "copy"),
    keyLabel("r", "rename"),
    keyLabel("x", "kill"),
    keyLabel("f", "fork"),
  ].join("\n");
}

function renderSendMessage(text: string, cursor: number): string {
  return [
    ` {bold}Send message{/bold}`,
    "",
    ` {${C.peach}-fg}\u276f{/${C.peach}-fg} ${renderTextWithCursor(text, cursor)}`,
    "",
    `  {${C.dim}-fg}Enter send \u00b7 Esc back{/${C.dim}-fg}`,
  ].join("\n");
}

export function renderSpaceMenu(state: SpaceMenuState): string {
  switch (state.level) {
    case "root":
      return renderRoot();
    case "send-message":
      return renderSendMessage(state.messageText, state.messageCursor);
  }
}

// --- Dimensions ---

export function getMenuDimensions(state: SpaceMenuState): { width: number; height: number } {
  switch (state.level) {
    case "root":
      return { width: 24, height: 7 };
    case "send-message":
      return { width: 42, height: 7 };
  }
}

// --- Key handling ---

export function handleSpaceMenuKey(
  state: SpaceMenuState,
  keyName: string,
  ch: string,
): SpaceMenuAction {
  switch (state.level) {
    case "root":
      return handleRootKey(keyName, ch);
    case "send-message":
      return handleSendMessageKey(state, keyName, ch);
  }
}

function handleRootKey(_keyName: string, ch: string): SpaceMenuAction {
  switch (ch) {
    case "m": return { type: "start-input" };
    case "c": return { type: "exec", command: "copy" };
    case "r": return { type: "exec", command: "rename" };
    case "x": return { type: "exec", command: "kill" };
    case "f": return { type: "exec", command: "fork" };
    default: return { type: "close" };
  }
}

function handleSendMessageKey(state: SpaceMenuState, keyName: string, ch: string): SpaceMenuAction {
  if (keyName === "escape") return { type: "back" };

  if (keyName === "enter" || keyName === "return") {
    if (state.messageText.trim()) {
      return { type: "send-text", text: state.messageText };
    }
    return { type: "noop" };
  }

  // Delegate to text input handler
  const result = handleTextInputKey(state.messageText, state.messageCursor, keyName, ch);
  if (result.handled) {
    state.messageText = result.text;
    state.messageCursor = result.cursor;
    return { type: "render" };
  }

  return { type: "noop" };
}
