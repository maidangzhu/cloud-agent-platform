// Workspace 纯逻辑：title 校验（Step 4.1，见 docs/testing-strategy.md
// §4.2 unit 1-3）。不接数据库，零外部依赖。

export function validateWorkspaceTitle(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return "title must not be empty";
  }
  return null;
}
