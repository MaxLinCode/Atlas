type PromptSection = {
  title: string;
  lines: string[];
};

export function buildPromptSpec(sections: PromptSection[]) {
  return sections
    .map((section) => [`${section.title}:`, ...section.lines].join("\n"))
    .join("\n\n");
}
