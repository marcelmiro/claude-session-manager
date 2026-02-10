import type { Widgets } from "blessed";
import { C } from "./colors";
import type { SessionStatus } from "../core/status";

export function renderStatusBar(box: Widgets.BoxElement, enterAction?: SessionStatus, showArchived = false): void {
  const enterLabel = enterAction === "archived" ? "resume" : "switch";
  const archiveLabel = showArchived ? "hide archived" : "show archived";
  const content =
    `{${C.peach}-fg}j/k/J/K{/${C.peach}-fg} {${C.dim}-fg}move{/${C.dim}-fg}` +
    `  {${C.peach}-fg}\u23CE{/${C.peach}-fg} {${C.dim}-fg}${enterLabel}{/${C.dim}-fg}` +
    `  {${C.peach}-fg}r{/${C.peach}-fg} {${C.dim}-fg}refresh{/${C.dim}-fg}` +
    `  {${C.peach}-fg}x{/${C.peach}-fg} {${C.dim}-fg}kill{/${C.dim}-fg}` +
    `  {${C.peach}-fg}f{/${C.peach}-fg} {${C.dim}-fg}fork{/${C.dim}-fg}` +
    `  {${C.peach}-fg}s{/${C.peach}-fg} {${C.dim}-fg}name{/${C.dim}-fg}` +
    `  {${C.peach}-fg}u/d{/${C.peach}-fg} {${C.dim}-fg}scroll{/${C.dim}-fg}` +
    `  {${C.peach}-fg}n{/${C.peach}-fg} {${C.dim}-fg}new{/${C.dim}-fg}` +
    `  {${C.peach}-fg}q{/${C.peach}-fg} {${C.dim}-fg}quit{/${C.dim}-fg}` +
    `  {${C.peach}-fg}a{/${C.peach}-fg} {${C.dim}-fg}${archiveLabel}{/${C.dim}-fg}`;
  box.setContent(content);
}
