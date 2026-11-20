import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(process.cwd());
const packageManifest = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
);
const directDependencies = new Set([
  ...Object.keys(packageManifest.dependencies ?? {}),
  ...Object.keys(packageManifest.devDependencies ?? {}),
]);
const packages = new Map();

await scanNodeModules(join(projectRoot, "node_modules"));

const rows = [...packages.values()].sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(
    `${right.name}@${right.version}`,
  ),
);

const markdown = [
  "# Volledige lijst geïnstalleerde projectpakketten",
  "",
  "Automatisch gegenereerd uit de lokale `node_modules`-map.",
  "De compacte toelichting staat in `GEINSTALLEERDE_SOFTWARE.md`.",
  "",
  `Totaal unieke pakketten: ${rows.length}.`,
  "",
  "| Pakket | Versie | Licentie | Soort |",
  "|---|---:|---|---|",
  ...rows.map(
    (entry) =>
      `| \`${escapeCell(entry.name)}\` | ${escapeCell(entry.version)} | ` +
      `${escapeCell(entry.license)} | ` +
      `${directDependencies.has(entry.name) ? "direct" : "transitief"} |`,
  ),
  "",
].join("\n");

await writeFile(
  join(projectRoot, "GEINSTALLEERDE_PAKKETTEN.md"),
  markdown,
  "utf8",
);

const unknownLicenses = rows.filter((entry) => entry.license === "ONBEKEND");
if (unknownLicenses.length > 0) {
  console.error(
    `Pakketten zonder herkenbare licentie: ${unknownLicenses
      .map((entry) => `${entry.name}@${entry.version}`)
      .join(", ")}`,
  );
  process.exitCode = 1;
} else {
  console.log(`${rows.length} unieke pakketten vastgelegd; alle licenties bekend.`);
}

async function scanNodeModules(nodeModulesDirectory) {
  if (!(await exists(nodeModulesDirectory))) {
    return;
  }

  const entries = await readdir(nodeModulesDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".pnpm") {
      continue;
    }

    if (entry.name.startsWith("@")) {
      const scopeDirectory = join(nodeModulesDirectory, entry.name);
      const scopedEntries = await readdir(scopeDirectory, {
        withFileTypes: true,
      });
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory()) {
          await inspectPackage(join(scopeDirectory, scopedEntry.name));
        }
      }
      continue;
    }

    await inspectPackage(join(nodeModulesDirectory, entry.name));
  }
}

async function inspectPackage(packageDirectory) {
  const manifestPath = join(packageDirectory, "package.json");
  if (!(await exists(manifestPath))) {
    return;
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof manifest.name === "string" && typeof manifest.version === "string") {
    const key = `${manifest.name}@${manifest.version}`;
    packages.set(key, {
      name: manifest.name,
      version: manifest.version,
      license: normalizeLicense(manifest.license ?? manifest.licenses),
    });
  }

  await scanNodeModules(join(packageDirectory, "node_modules"));
}

function normalizeLicense(license) {
  if (typeof license === "string" && license.trim()) {
    return license.trim();
  }
  if (Array.isArray(license)) {
    const values = license.map(normalizeLicense).filter((value) => value !== "ONBEKEND");
    return values.length > 0 ? values.join(" OR ") : "ONBEKEND";
  }
  if (license && typeof license === "object" && typeof license.type === "string") {
    return license.type;
  }
  return "ONBEKEND";
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
