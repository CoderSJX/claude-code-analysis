import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

type ToolType = "read" | "write" | "bash" | "mcp";
type PermissionMode = "bypassPermissions" | "dontAsk" | "auto" | "acceptEdits" | "default" | "plan" | "bubble";
type Resolution = "ALLOWED" | "DENIED" | "ASK_USER";

interface FlowNode {
  id: string;
  label: string;
  detail: string;
  type: "decision" | "result";
}

interface FlowPath {
  nodes: string[];
  result: Resolution;
  explanation: string;
}

interface Preset {
  label: string;
  tool: ToolType;
  mode: PermissionMode;
  hasHook: boolean;
  hookDecision?: Resolution;
}

// --- Data ---

const toolTypes: { value: ToolType; label: string }[] = [
  { value: "read", label: "读取文件" },
  { value: "write", label: "写入文件" },
  { value: "bash", label: "Bash 命令" },
  { value: "mcp", label: "MCP 工具" },
];

const permissionModes: { value: PermissionMode; label: string; description: string }[] = [
  { value: "bypassPermissions", label: "bypassPermissions", description: "全部放行，不做任何检查，只用于内部或测试场景" },
  { value: "dontAsk", label: "dontAsk", description: "全部放行，但仍会记录日志，不弹出用户确认" },
  { value: "auto", label: "auto", description: "由 LLM 转录分类器决定允许还是拒绝" },
  { value: "acceptEdits", label: "acceptEdits", description: "文件编辑自动批准，其他变更仍需确认" },
  { value: "default", label: "default", description: "标准交互模式，每个动作都由用户确认" },
  { value: "plan", label: "plan", description: "只读模式，所有变更都会被阻止" },
  { value: "bubble", label: "bubble", description: "把决策升级到父级智能体（子智能体模式）" },
];

const presets: Preset[] = [
  { label: "auto 模式下读取文件", tool: "read", mode: "auto", hasHook: false },
  { label: "plan 模式下执行 rm", tool: "bash", mode: "plan", hasHook: false },
  { label: "Hook 覆盖写入决策", tool: "write", mode: "default", hasHook: true, hookDecision: "ALLOWED" },
  { label: "default 模式下调用 MCP 工具", tool: "mcp", mode: "default", hasHook: false },
  { label: "dontAsk 模式下执行 Bash", tool: "bash", mode: "dontAsk", hasHook: false },
  { label: "写入被 Hook 阻止", tool: "write", mode: "acceptEdits", hasHook: true, hookDecision: "DENIED" },
];

const allNodes: Record<string, FlowNode> = {
  start: { id: "start", label: "工具调用需要权限", detail: "模型响应里解析出了一个 `tool_use` 块", type: "decision" },
  hookCheck: { id: "hookCheck", label: "Hook 规则是否匹配？", detail: "检查是否有 `PreToolUse` hook 命中了这次工具调用", type: "decision" },
  hookDecision: { id: "hookDecision", label: "采用 Hook 的决定", detail: "Hook 返回 allow、deny 或 ask，会直接覆盖其他检查", type: "decision" },
  checkPerms: { id: "checkPerms", label: "tool.checkPermissions()", detail: "每个工具都定义了自己的权限逻辑（只读工具通常直接返回 `allow`）", type: "decision" },
  toolAllow: { id: "toolAllow", label: "工具自行放行", detail: "`checkPermissions()` 返回了 `allow`，说明该工具本身就足够安全", type: "decision" },
  modeCheck: { id: "modeCheck", label: "当前权限模式？", detail: "检查当前启用的权限模式（共 7 种，从最宽松到最严格）", type: "decision" },
  bypassAllow: { id: "bypassAllow", label: "bypassPermissions / dontAsk", detail: "没有限制，直接放行", type: "decision" },
  planDeny: { id: "planDeny", label: "plan 模式：只读", detail: "所有变更都被阻止，只有只读操作可以通过", type: "decision" },
  planReadCheck: { id: "planReadCheck", label: "它是只读操作吗？", detail: "plan 模式允许读取，但会阻止写入和执行类操作", type: "decision" },
  acceptEditsCheck: { id: "acceptEditsCheck", label: "acceptEdits：是否为文件写入？", detail: "文件编辑会被自动批准，其他变更则需要用户确认", type: "decision" },
  autoClassifier: { id: "autoClassifier", label: "LLM 分类器评估中", detail: "轻量级 LLM 会结合对话转录内容，对这次工具调用做分类判断", type: "decision" },
  promptUser: { id: "promptUser", label: "提示用户确认", detail: "用户会看到：允许一次 / 会话内允许 / 永久允许 / 拒绝", type: "decision" },
  bubbleUp: { id: "bubbleUp", label: "升级到父级处理", detail: "子智能体不能自己批准危险动作，权限请求会向上冒泡", type: "decision" },
  resultAllow: { id: "resultAllow", label: "允许", detail: "工具可以继续执行", type: "result" },
  resultDeny: { id: "resultDeny", label: "拒绝", detail: "工具执行被阻止，错误会返回给模型", type: "result" },
  resultAsk: { id: "resultAsk", label: "询问用户", detail: "向用户展示交互式权限确认弹窗", type: "result" },
};

function resolvePermission(
  tool: ToolType,
  mode: PermissionMode,
  hasHook: boolean,
  hookDecision?: Resolution
): FlowPath {
  const nodes: string[] = ["start", "hookCheck"];

  if (hasHook && hookDecision) {
    nodes.push("hookDecision");
    if (hookDecision === "ALLOWED") {
      nodes.push("resultAllow");
      return { nodes, result: "ALLOWED", explanation: "PreToolUse hook matched and returned allow -- skips all other checks" };
    }
    if (hookDecision === "DENIED") {
      nodes.push("resultDeny");
      return { nodes, result: "DENIED", explanation: "PreToolUse hook matched and returned deny -- tool blocked before permission prompt" };
    }
    nodes.push("resultAsk");
    return { nodes, result: "ASK_USER", explanation: "PreToolUse hook matched and returned ask -- user must decide" };
  }

  nodes.push("checkPerms");

  // Read-only tools self-allow
  if (tool === "read") {
    nodes.push("toolAllow", "resultAllow");
    return { nodes, result: "ALLOWED", explanation: "Read tool's checkPermissions() returns 'allow' -- read-only tools are inherently safe" };
  }

  nodes.push("modeCheck");

  switch (mode) {
    case "bypassPermissions":
    case "dontAsk":
      nodes.push("bypassAllow", "resultAllow");
      return { nodes, result: "ALLOWED", explanation: `${mode} mode: all tool calls are allowed without prompting` };

    case "plan":
      nodes.push("planDeny");
      if (tool === "read") {
        nodes.push("planReadCheck", "resultAllow");
        return { nodes, result: "ALLOWED", explanation: "Plan mode allows read operations" };
      }
      nodes.push("resultDeny");
      return { nodes, result: "DENIED", explanation: "Plan mode: all mutations are blocked. Only read operations are allowed" };

    case "acceptEdits":
      nodes.push("acceptEditsCheck");
      if (tool === "write") {
        nodes.push("resultAllow");
        return { nodes, result: "ALLOWED", explanation: "acceptEdits mode: file write operations are auto-approved" };
      }
      nodes.push("resultAsk");
      return { nodes, result: "ASK_USER", explanation: "acceptEdits mode: non-write operations require user approval" };

    case "auto":
      nodes.push("autoClassifier");
      // For the interactive demo, auto mode allows writes and denies dangerous bash
      if (tool === "bash") {
        nodes.push("resultAsk");
        return { nodes, result: "ASK_USER", explanation: "Auto mode: LLM classifier flagged this bash command as potentially unsafe" };
      }
      nodes.push("resultAllow");
      return { nodes, result: "ALLOWED", explanation: "Auto mode: LLM classifier determined this action is consistent with user intent" };

    case "default":
      nodes.push("promptUser", "resultAsk");
      return { nodes, result: "ASK_USER", explanation: "Default mode: user must approve each mutation interactively" };

    case "bubble":
      nodes.push("bubbleUp", "resultAsk");
      return { nodes, result: "ASK_USER", explanation: "Bubble mode: sub-agent escalates permission to parent agent or user" };
  }
}

// --- Helpers ---

function useDarkMode() {
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const check = () =>
      setIsDark(document.documentElement.classList.contains("dark"));
    check();
    window.addEventListener("theme-changed", check);
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      window.removeEventListener("theme-changed", check);
      observer.disconnect();
    };
  }, []);
  return isDark;
}

function ResultBadge({ result, isDark }: { result: Resolution; isDark: boolean }) {
  const config = {
    ALLOWED: {
      bg: isDark ? "rgba(34, 197, 94, 0.15)" : "rgba(34, 197, 94, 0.12)",
      border: "rgba(34, 197, 94, 0.4)",
      color: "#22c55e",
      label: "允许",
    },
    DENIED: {
      bg: isDark ? "rgba(239, 68, 68, 0.15)" : "rgba(239, 68, 68, 0.1)",
      border: "rgba(239, 68, 68, 0.4)",
      color: "#ef4444",
      label: "拒绝",
    },
    ASK_USER: {
      bg: isDark ? "rgba(234, 179, 8, 0.15)" : "rgba(234, 179, 8, 0.1)",
      border: "rgba(234, 179, 8, 0.4)",
      color: "#eab308",
      label: "询问用户",
    },
  }[result];

  return (
    <motion.span
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
      style={{
        display: "inline-block",
        padding: "6px 16px",
        borderRadius: 8,
        background: config.bg,
        border: `1.5px solid ${config.border}`,
        color: config.color,
        fontSize: 14,
        fontWeight: 700,
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.05em",
      }}
    >
      {config.label}
    </motion.span>
  );
}

// --- Component ---

interface Props {
  className?: string;
}

export default function PermissionResolver({ className }: Props) {
  const isDark = useDarkMode();
  const [tool, setTool] = useState<ToolType>("write");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [hasHook, setHasHook] = useState(false);
  const [hookDecision, setHookDecision] = useState<Resolution>("ALLOWED");
  const [resolved, setResolved] = useState<FlowPath | null>(null);
  const [animatingIdx, setAnimatingIdx] = useState(-1);
  const abortRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const colors = {
    accent: "#d97757",
    accentDim: "rgba(217, 119, 87, 0.3)",
    accentBg: isDark ? "rgba(217, 119, 87, 0.08)" : "rgba(217, 119, 87, 0.05)",
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    green: "#22c55e",
    red: "#ef4444",
    amber: "#eab308",
  };

  const reset = useCallback(() => {
    abortRef.current = true;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setResolved(null);
    setAnimatingIdx(-1);
  }, []);

  const resolve = useCallback(async () => {
    reset();
    await new Promise((r) => setTimeout(r, 50));
    abortRef.current = false;

    const path = resolvePermission(tool, mode, hasHook, hasHook ? hookDecision : undefined);
    setResolved(path);

    // Animate through nodes
    for (let i = 0; i < path.nodes.length; i++) {
      if (abortRef.current) return;
      setAnimatingIdx(i);
      await new Promise<void>((res) => {
        timeoutRef.current = setTimeout(res, 350);
      });
    }
  }, [tool, mode, hasHook, hookDecision, reset]);

  const applyPreset = useCallback((preset: Preset) => {
    reset();
    setTool(preset.tool);
    setMode(preset.mode);
    setHasHook(preset.hasHook);
    if (preset.hookDecision) setHookDecision(preset.hookDecision);
  }, [reset]);

  useEffect(() => {
    return () => {
      abortRef.current = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const selectStyle = {
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    padding: "6px 10px",
    borderRadius: 6,
    border: `1px solid ${colors.cardBorder}`,
    background: isDark ? "#30302e" : "#f5f4ed",
    color: colors.text,
    cursor: "pointer" as const,
    width: "100%",
  };

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Controls panel */}
      <div
        style={{
          padding: "16px 20px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 16,
            marginBottom: 16,
          }}
        >
          {/* Tool type */}
          <div>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                color: colors.textSecondary,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              工具类型
            </label>
            <select value={tool} onChange={(e) => { setTool(e.target.value as ToolType); reset(); }} style={selectStyle}>
              {toolTypes.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Permission mode */}
          <div>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                color: colors.textSecondary,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              权限模式
            </label>
            <select value={mode} onChange={(e) => { setMode(e.target.value as PermissionMode); reset(); }} style={selectStyle}>
              {permissionModes.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          {/* Hook toggle */}
          <div>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                color: colors.textSecondary,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Hook 规则
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  color: colors.text,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={hasHook}
                  onChange={(e) => { setHasHook(e.target.checked); reset(); }}
                  style={{ accentColor: colors.accent }}
                />
                存在匹配的 Hook
              </label>
              {hasHook && (
                <select
                  value={hookDecision}
                  onChange={(e) => { setHookDecision(e.target.value as Resolution); reset(); }}
                  style={{ ...selectStyle, width: "auto" }}
                >
                  <option value="ALLOWED">allow</option>
                  <option value="DENIED">deny</option>
                  <option value="ASK_USER">ask</option>
                </select>
              )}
            </div>
          </div>
        </div>

        {/* Mode description */}
        <div
          style={{
            fontSize: 12,
            color: colors.textSecondary,
            fontFamily: "var(--font-mono)",
            padding: "8px 12px",
            background: isDark ? "rgba(135,134,127,0.08)" : "rgba(135,134,127,0.06)",
            borderRadius: 6,
            marginBottom: 16,
          }}
        >
          {permissionModes.find((m) => m.value === mode)?.description}
        </div>

        {/* Resolve button */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button
            onClick={resolve}
            style={{
              padding: "8px 24px",
              borderRadius: 8,
              border: "none",
              background: colors.accent,
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
              transition: "background 0.2s",
            }}
          >
            开始解析
          </button>

          {resolved && (
            <button
              onClick={reset}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: `1px solid ${colors.cardBorder}`,
                background: colors.cardBg,
                color: colors.text,
                fontSize: 13,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
              }}
            >
              清除
            </button>
          )}
        </div>
      </div>

      {/* Presets */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 20,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
            alignSelf: "center",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          预设：
        </span>
        {presets.map((preset) => (
          <button
            key={preset.label}
            onClick={() => applyPreset(preset)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: `1px solid ${colors.cardBorder}`,
              background: colors.cardBg,
              color: colors.text,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
              transition: "border-color 0.2s",
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLButtonElement).style.borderColor = colors.accent;
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLButtonElement).style.borderColor = colors.cardBorder;
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Decision tree visualization */}
      <AnimatePresence>
        {resolved && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            {/* Flow path */}
            <div style={{ position: "relative", paddingLeft: 28 }}>
              {/* Vertical connector */}
              <div
                style={{
                  position: "absolute",
                  left: 14,
                  top: 20,
                  bottom: 20,
                  width: 2,
                  background: colors.cardBorder,
                }}
              />

              {resolved.nodes.map((nodeId, i) => {
                const node = allNodes[nodeId];
                if (!node) return null;

                const isAnimated = i <= animatingIdx;
                const isCurrent = i === animatingIdx;
                const isResult = node.type === "result";

                let dotColor = colors.cardBorder;
                let borderColor = colors.cardBorder;
                let bgColor = colors.cardBg;

                if (isAnimated) {
                  dotColor = colors.accent;
                  borderColor = colors.accent;
                  bgColor = colors.accentBg;
                }
                if (isResult && isAnimated) {
                  if (resolved.result === "ALLOWED") {
                    dotColor = colors.green;
                    borderColor = "rgba(34, 197, 94, 0.4)";
                    bgColor = isDark ? "rgba(34, 197, 94, 0.08)" : "rgba(34, 197, 94, 0.05)";
                  } else if (resolved.result === "DENIED") {
                    dotColor = colors.red;
                    borderColor = "rgba(239, 68, 68, 0.4)";
                    bgColor = isDark ? "rgba(239, 68, 68, 0.08)" : "rgba(239, 68, 68, 0.05)";
                  } else {
                    dotColor = colors.amber;
                    borderColor = "rgba(234, 179, 8, 0.4)";
                    bgColor = isDark ? "rgba(234, 179, 8, 0.08)" : "rgba(234, 179, 8, 0.05)";
                  }
                }

                return (
                  <motion.div
                    key={nodeId + "-" + i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: isAnimated ? 1 : 0.3, x: 0 }}
                    transition={{ duration: 0.3, delay: i * 0.05 }}
                    style={{
                      position: "relative",
                      marginBottom: i < resolved.nodes.length - 1 ? 8 : 0,
                    }}
                  >
                    {/* Dot */}
                    <div
                      style={{
                        position: "absolute",
                        left: -28 + 14 - 5,
                        top: "50%",
                        transform: "translateY(-50%)",
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: dotColor,
                        transition: "background 0.3s",
                        zIndex: 1,
                      }}
                    />

                    {/* Pulse on current */}
                    {isCurrent && (
                      <motion.div
                        style={{
                          position: "absolute",
                          left: -28 + 14 - 10,
                          top: "50%",
                          transform: "translateY(-50%)",
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          border: `2px solid ${dotColor}`,
                          zIndex: 0,
                        }}
                        animate={{ scale: [1, 1.5, 1], opacity: [0.6, 0, 0.6] }}
                        transition={{ duration: 1, repeat: Infinity }}
                      />
                    )}

                    {/* Node card */}
                    <div
                      style={{
                        padding: "10px 14px",
                        borderRadius: 10,
                        border: `1px solid ${borderColor}`,
                        background: bgColor,
                        transition: "border-color 0.3s, background 0.3s",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {!isResult && (
                          <span
                            style={{
                              fontSize: 12,
                              color: isAnimated ? colors.accent : colors.textSecondary,
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {node.type === "decision" ? "?" : ""}
                          </span>
                        )}
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: isResult ? 700 : 600,
                            fontFamily: "var(--font-mono)",
                            color: isResult && isAnimated
                              ? dotColor
                              : isAnimated
                                ? colors.accent
                                : colors.text,
                            flex: 1,
                          }}
                        >
                          {node.label}
                        </span>
                        {isResult && isAnimated && (
                          <ResultBadge result={resolved.result} isDark={isDark} />
                        )}
                      </div>

                      {isAnimated && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          transition={{ duration: 0.2 }}
                          style={{ overflow: "hidden" }}
                        >
                          <div
                            style={{
                              fontSize: 12,
                              color: colors.textSecondary,
                              marginTop: 4,
                              lineHeight: 1.4,
                            }}
                          >
                            {node.detail}
                          </div>
                        </motion.div>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {/* Explanation */}
            {animatingIdx >= resolved.nodes.length - 1 && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                style={{
                  marginTop: 16,
                  padding: "14px 20px",
                  borderRadius: 12,
                  border: `1px solid ${colors.accentDim}`,
                  background: colors.accentBg,
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    color: colors.text,
                    lineHeight: 1.5,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontFamily: "var(--font-mono)",
                      color: colors.accent,
                      marginRight: 8,
                    }}
                  >
                    解析结果：
                  </span>
                  {resolved.explanation}
                </div>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Permission modes reference table */}
      {!resolved && (
        <div
          style={{
            borderRadius: 12,
            border: `1px solid ${colors.cardBorder}`,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "10px 16px",
              background: isDark ? "rgba(135,134,127,0.08)" : "rgba(135,134,127,0.04)",
              borderBottom: `1px solid ${colors.cardBorder}`,
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              color: colors.textSecondary,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            权限模式参考（从最宽松到最严格）
          </div>
          {permissionModes.map((m, i) => (
            <div
              key={m.value}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 16px",
                borderBottom: i < permissionModes.length - 1 ? `1px solid ${colors.cardBorder}` : "none",
                background: mode === m.value ? colors.accentBg : "transparent",
                cursor: "pointer",
                transition: "background 0.2s",
              }}
              onClick={() => { setMode(m.value); reset(); }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  fontWeight: 600,
                  color: mode === m.value ? colors.accent : colors.text,
                  minWidth: 140,
                }}
              >
                {m.label}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: colors.textSecondary,
                  flex: 1,
                }}
              >
                {m.description}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
