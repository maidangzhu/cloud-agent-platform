// Thread PATCH 时显式传入的 title 校验（Step 5.1，同构
// workspace/validation.ts）。注意这和 title.ts 的 deriveThreadTitle 是
// 两件事：创建时空 title 允许，走派生逻辑；更新时显式传入空 title 视为
// 无效输入，直接拒绝（不会静默回退成默认标题）。

export function validateThreadTitle(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return "title must not be empty";
  }
  return null;
}
