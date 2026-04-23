// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("../package.json") as { version: string };

export const BASE_URL = "https://opencode.ai/zen/go/v1";
export const EXTENSION_VERSION: string = pkg.version;
