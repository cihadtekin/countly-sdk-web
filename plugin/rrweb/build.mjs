// Builds plugin/rrweb/countly_rrweb.js and its minified copy from src/, with @rrweb/record
// bundled in (pinned in package.json). Run with npm run build:rrweb.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const common = { entryPoints: [join(here, "src", "countly_rrweb.js")], bundle: true, format: "iife", target: ["es2018"], legalComments: "inline" };
await build({ ...common, outfile: join(here, "countly_rrweb.js") });
await build({ ...common, outfile: join(here, "countly_rrweb.min.js"), minify: true });
console.log("build:rrweb, wrote plugin/rrweb/countly_rrweb.js and countly_rrweb.min.js");
