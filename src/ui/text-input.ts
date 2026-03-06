/**
 * Centralized text input key handler. Returns new text, cursor, and whether the key was handled.
 * Supports: backspace, delete, alt+backspace (word delete), ctrl+u (clear line),
 * left/right, alt+left/right (word jump).
 * Optional charFilter restricts which printable chars are accepted.
 */
export function handleTextInputKey(
  text: string,
  cursor: number,
  keyName: string,
  ch: string,
  charFilter?: RegExp,
): { text: string; cursor: number; handled: boolean } {
  switch (keyName) {
    case "backspace": {
      if (cursor === 0) return { text, cursor, handled: true };
      return {
        text: text.slice(0, cursor - 1) + text.slice(cursor),
        cursor: cursor - 1,
        handled: true,
      };
    }
    case "delete": {
      if (cursor >= text.length) return { text, cursor, handled: true };
      return {
        text: text.slice(0, cursor) + text.slice(cursor + 1),
        cursor,
        handled: true,
      };
    }
    case "M-backspace": {
      // Alt+Backspace: delete word backward
      if (cursor === 0) return { text, cursor, handled: true };
      const before = text.slice(0, cursor);
      const stripped = before.replace(/[^a-zA-Z0-9]+$/, "");
      const newBefore = stripped.replace(/[a-zA-Z0-9]+$/, "");
      return {
        text: newBefore + text.slice(cursor),
        cursor: newBefore.length,
        handled: true,
      };
    }
    case "C-u": {
      // Ctrl+U / Cmd+Delete: clear entire line
      return { text: "", cursor: 0, handled: true };
    }
    case "left": {
      return { text, cursor: Math.max(0, cursor - 1), handled: true };
    }
    case "right": {
      return { text, cursor: Math.min(text.length, cursor + 1), handled: true };
    }
    case "M-left":
    case "M-b": {
      // Alt+Left: move word backward (M-b = macOS "Option as Esc+" sends ESC+b)
      const before = text.slice(0, cursor);
      const stripped = before.replace(/[^a-zA-Z0-9]+$/, "");
      const wordStart = stripped.replace(/[a-zA-Z0-9]+$/, "");
      return { text, cursor: wordStart.length, handled: true };
    }
    case "M-right":
    case "M-f": {
      // Alt+Right: move word forward (M-f = macOS "Option as Esc+" sends ESC+f)
      const after = text.slice(cursor);
      const skipSep = after.replace(/^[^a-zA-Z0-9]+/, "");
      const skipWord = skipSep.replace(/^[a-zA-Z0-9]+/, "");
      return { text, cursor: text.length - skipWord.length, handled: true };
    }
    case "home": {
      // Cmd+Left sends Home in iTerm2
      return { text, cursor: 0, handled: true };
    }
    case "end": {
      // Cmd+Right sends End in iTerm2
      return { text, cursor: text.length, handled: true };
    }
    default: {
      // Printable character: insert at cursor
      if (ch && ch.length === 1 && ch >= " ") {
        if (charFilter && !charFilter.test(ch)) return { text, cursor, handled: false };
        return {
          text: text.slice(0, cursor) + ch + text.slice(cursor),
          cursor: cursor + 1,
          handled: true,
        };
      }
      return { text, cursor, handled: false };
    }
  }
}

/** Render text with a block cursor at the given position using {inverse} tag. */
export function renderTextWithCursor(text: string, cursor: number): string {
  if (cursor >= text.length) {
    return text + "█";
  }
  const before = text.slice(0, cursor);
  const charAtCursor = text[cursor];
  const after = text.slice(cursor + 1);
  return `${before}{inverse}${charAtCursor}{/inverse}${after}`;
}
