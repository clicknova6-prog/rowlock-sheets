import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve(".server/server.js");
const target = resolve("server.js");

await access(source);
await writeFile(target, 'import "./.server/server.js";\n');
