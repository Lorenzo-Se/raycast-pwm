import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const helperPath = join(root, "assets", "session-helper.mjs");

if (!existsSync(helperPath)) {
  console.error(`Missing session helper at ${helperPath}`);
  process.exit(1);
}

try {
  accessSync(helperPath, constants.R_OK);
} catch {
  console.error(`Session helper is not readable: ${helperPath}`);
  process.exit(1);
}

console.log(`Session helper ready at ${helperPath}`);
