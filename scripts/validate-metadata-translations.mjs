import { readFile } from "node:fs/promises";

const metadata = JSON.parse(
  await readFile(new URL("../free-at-home-metadata.json", import.meta.url)),
);
const languages = ["en", "nl", "de"];
const errors = [];

for (const field of ["name", "description"]) {
  const value = metadata[field];
  for (const language of languages) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value[language] !== "string" ||
      value[language].trim().length === 0
    ) {
      errors.push(`${field}.${language} is missing`);
    }
  }
}

for (const [groupId, group] of Object.entries(metadata.parameters ?? {})) {
  checkText(group, "name", `parameters.${groupId}`);

  for (const [itemId, item] of Object.entries(group.items ?? {})) {
    const path = `parameters.${groupId}.items.${itemId}`;
    checkText(item, "name", path);
    checkText(item, "description", path);
    if (item.type === "button") {
      for (const field of ["confirm", "buttonLabel"]) {
        if (item[field] !== undefined) checkText(item, field, path);
      }
    }
  }
}

if (errors.length > 0) {
  console.error("Metadata translation validation failed:");
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(
    "Metadata translations are complete for English, Dutch and German.",
  );
}

function checkText(entry, field, path) {
  if (
    typeof entry[field] !== "string" ||
    entry[field].trim().length === 0
  ) {
    errors.push(`${path}.${field} is missing`);
  }

  for (const language of languages) {
    const key = `${field}@${language}`;
    if (
      typeof entry[key] !== "string" ||
      entry[key].trim().length === 0
    ) {
      errors.push(`${path}.${key} is missing`);
    }
  }
}
