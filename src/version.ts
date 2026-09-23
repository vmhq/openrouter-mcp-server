import { readFileSync } from "node:fs";

/** Version from package.json (one level above both src/ and dist/). */
export const SERVER_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version: string;
  }
).version;
