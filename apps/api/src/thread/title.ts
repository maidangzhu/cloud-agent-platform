// Thread title 派生（Step 5.1，见 docs/testing-strategy.md §4.3 unit 1-2、
// docs/api-contract.md §5.3 规则"title 为空时，从 initial prompt 推导或
// 使用默认标题"）。截断长度和默认标题沿用 v1 既有约定（见
// src/app/api/sessions/route.ts 的 100 字符截断 + "New session"兜底），
// 只是默认标题换成"New thread"以匹配 v2 概念命名。

const MAX_TITLE_LENGTH = 100;
const DEFAULT_TITLE = "New thread";

export function deriveThreadTitle(
  title: string | undefined,
  initialPrompt: string | undefined,
): string {
  if (title && title.trim()) {
    return title.trim().slice(0, MAX_TITLE_LENGTH);
  }
  if (initialPrompt && initialPrompt.trim()) {
    return initialPrompt.trim().slice(0, MAX_TITLE_LENGTH);
  }
  return DEFAULT_TITLE;
}
