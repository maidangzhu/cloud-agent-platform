// Run 创建时的 prompt 校验（Step 6.3，见 docs/testing-strategy.md §4.4
// route 16"create run rejects empty prompt"）。

export function validateRunPrompt(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return "prompt must not be empty";
  }
  return null;
}
