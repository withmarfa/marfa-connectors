declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const highlightedCodeBlock: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}
