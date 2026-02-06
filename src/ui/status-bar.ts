import type { Widgets } from "blessed";
import { C } from "./colors";

export function renderStatusBar(box: Widgets.BoxElement): void {
  const content =
    `{${C.peach}-fg}j/k \u2191\u2193{/${C.peach}-fg} {${C.dim}-fg}move{/${C.dim}-fg}` +
    `    {${C.peach}-fg}\u23CE{/${C.peach}-fg} {${C.dim}-fg}switch{/${C.dim}-fg}` +
    `    {${C.peach}-fg}r{/${C.peach}-fg} {${C.dim}-fg}resume{/${C.dim}-fg}` +
    `    {${C.peach}-fg}R{/${C.peach}-fg} {${C.dim}-fg}refresh{/${C.dim}-fg}` +
    `    {${C.peach}-fg}q{/${C.peach}-fg} {${C.dim}-fg}quit{/${C.dim}-fg}`;
  box.setContent(content);
}
