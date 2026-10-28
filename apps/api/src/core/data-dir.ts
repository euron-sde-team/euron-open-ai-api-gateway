import path from "node:path";
import { config } from "./config";

/** Where the mail outbox lives. Never used when MAIL_MODE is smtp or ses. */
export function dataDir(...parts: string[]): string {
  return path.join(config.DATA_DIR || path.join(process.cwd(), "data"), ...parts);
}
