import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(projectRoot, "dist");
const templatePath = join(projectRoot, "templates", "index.html");
const staticDirectory = join(projectRoot, "static");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const html = await readFile(templatePath, "utf8");
const staticHtml = html.replace(
  /\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g,
  (_match, filename) => `/static/${filename}`,
);
if (staticHtml.includes("{{ url_for(")) {
  throw new Error("Unconverted Flask static URL remains in templates/index.html");
}

await writeFile(join(outputDirectory, "index.html"), staticHtml);
await cp(staticDirectory, join(outputDirectory, "static"), { recursive: true });
