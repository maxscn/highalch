import { createStart } from "@tanstack/react-start";

/**
 * The app renders in the browser only: its data comes over the Console Api's WebSocket client
 * (live collections), which server rendering has no session to open. The server renders the
 * document shell (head, theme script, styles).
 */
export const startInstance = createStart(() => ({ defaultSsr: false }));
