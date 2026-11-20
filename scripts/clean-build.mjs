import { rmSync } from "node:fs";
import { relative, resolve } from "node:path";

const projectRoot = resolve(process.cwd());
const buildDirectory = resolve(projectRoot, "build");
const relativeTarget = relative(projectRoot, buildDirectory);

if (
  relativeTarget === "" ||
  relativeTarget.startsWith("..") ||
  relativeTarget.includes(":")
) {
  throw new Error(`Refusing to clean unexpected path: ${buildDirectory}`);
}

rmSync(buildDirectory, { recursive: true, force: true });
