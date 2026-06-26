"use client";
import { useRef, useState } from "react";

/**
 * 标题编辑单元：默认渲染为可点击的 span；点击后变 input。
 *
 * 交互：
 * - Enter 保存
 * - Esc 取消
 * - blur 保存（失焦时如果未保存就保存）
 * - IME 合成期（CJK 等）按 Enter 不提交：`e.nativeEvent.isComposing` 或 `keyCode === 229`
 *   时一律视为 IME 的"确认"，而不是"提交"
 *
 * 数据流：父组件用 `onSave(newTitle)` 调 PATCH 端点；成功由父组件触发 refetch 校正服务端真值。
 * 这里也支持外部 `pending` 状态：true 时禁用 input，避免重复提交。
 */
export function EditableTitle({
  value,
  onSave,
  disabled,
  className = "",
}: {
  value: string;
  /** 返回 Promise；resolve 即视为成功（可由父组件在外层处理失败回滚）。 */
  onSave: (next: string) => Promise<void> | void;
  disabled?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  // 用「上次提交后外部真值」跟踪：仅在 editing 状态时才是用户输入的草稿；
  // 退出编辑时已 commit / 取消。
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 保存原始值用于 Esc 回滚
  const originalRef = useRef(value);

  // 当外部真值变化（例如父组件 refetch 后回填），非编辑态下同步草稿基准；
  // 这步在编辑期内不发生，因为 setEditing(false) 之后才走到这里。
  // 用「渲染期派生」的方式避免 useEffect 触发的级联渲染。
  if (!editing && draft !== value) {
    setDraft(value);
  }

  function startEdit() {
    if (disabled || saving) return;
    originalRef.current = value;
    setDraft(value);
    setEditing(true);
  }

  function cancelEdit() {
    setDraft(originalRef.current);
    setEditing(false);
  }

  async function commit() {
    const next = draft.trim();
    // 空标题视为取消（避免把 session 改成空）
    if (!next) {
      cancelEdit();
      return;
    }
    if (next === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch (err) {
      // 父组件应负责回滚/告警；这里只退出编辑态
      console.error("[EditableTitle] save failed:", err);
      setDraft(originalRef.current);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        // IME 期间 Enter（keyCode 229 / isComposing）由输入法消费，绝不提交
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelEdit();
          }
        }}
        onBlur={() => {
          // blur 时若仍在 saving（极少见），等 saving 结束再统一处理
          if (saving) return;
          void commit();
        }}
        disabled={saving}
        autoFocus
        // 进入编辑时全选，方便直接覆盖输入
        onFocus={(e) => e.currentTarget.select()}
        maxLength={100}
        aria-label="编辑 session 标题"
        className={
          "bg-transparent border-b border-zinc-600 outline-none text-sm font-medium text-white " +
          "focus:border-zinc-300 px-0 py-0 w-full max-w-md " +
          className
        }
      />
    );
  }

  return (
    <button
      type="button"
      onClick={startEdit}
      disabled={disabled}
      title={disabled ? "" : "点击编辑标题"}
      className={
        "group flex items-center gap-1.5 max-w-md truncate text-left text-sm font-medium " +
        "text-zinc-300 hover:text-white transition-colors " +
        (disabled ? "cursor-default" : "cursor-text") +
        " " +
        className
      }
    >
      <span className="truncate">{value || "Chat"}</span>
      {/* 悬停时显示铅笔提示 */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3.5 w-3.5 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity"
        aria-hidden="true"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    </button>
  );
}