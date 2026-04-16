import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed";

type CommunicationPattern = "foreground" | "background" | "coordinator";

interface Transition {
  from: TaskStatus;
  to: TaskStatus;
  label: string;
  trigger: string;
  detail: string;
}

// --- Data ---

const transitions: Transition[] = [
  {
    from: "pending",
    to: "running",
    label: "开始执行",
    trigger: "任务已注册，并开始第一次执行",
    detail:
      "这是任务注册完成到第一次执行真正开始之间的短暂状态。一旦智能体循环或 shell 进程启动，任务就会进入 running。",
  },
  {
    from: "running",
    to: "completed",
    label: "正常结束",
    trigger: "智能体顺利完成工作，或 shell 以 0 退出",
    detail:
      "任务已经产出结果。输出会写入磁盘文件，在通知父级之后，`notified` 标记会被置为 true。",
  },
  {
    from: "running",
    to: "failed",
    label: "发生错误",
    trigger: "未处理异常、API 错误或工具失败",
    detail:
      "执行过程因错误终止。错误会被写入任务输出文件，并通过 task-notification XML 上报。",
  },
  {
    from: "running",
    to: "killed",
    label: "中止 / 用户停止",
    trigger: "用户按下 ESC、协调器调用 TaskStop，或收到了 abort 信号",
    detail:
      "任务被显式终止。abort controller 会触发，清理逻辑在 finally 块里执行，不会生成最终结果。",
  },
];

const statusPositions: Record<TaskStatus, { x: number; y: number }> = {
  pending: { x: 80, y: 100 },
  running: { x: 280, y: 100 },
  completed: { x: 480, y: 40 },
  failed: { x: 480, y: 100 },
  killed: { x: 480, y: 160 },
};

const statusColors: Record<TaskStatus, string> = {
  pending: "#87867f",
  running: "#d97757",
  completed: "#4ade80",
  failed: "#ef4444",
  killed: "#f59e0b",
};

const statusLabels: Record<TaskStatus, string> = {
  pending: "待执行",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  killed: "已终止",
};

const communicationPatterns: Record<
  CommunicationPattern,
  { title: string; description: string; details: string[] }
> = {
  foreground: {
    title: "前台（同步）",
    description:
      "父级直接迭代 `runAgent()` generator，消息沿调用栈逐层向上返回。",
    details: [
      "父级调用 `runAgent()` 并直接迭代这个 async generator",
      "每条消息都会立刻 yield 回父级",
      "共享父级的 abort controller（按 ESC 会同时终止两者）",
      "可通过 `Promise.race` 在执行中途切换到后台模式",
      "无需落盘输出，消息沿 generator 链直接传递",
    ],
  },
  background: {
    title: "后台（异步）",
    description:
      "依靠三条通道协作：磁盘输出文件、task-notification 和待处理消息队列。",
    details: [
      "磁盘：每个任务都会写入自己的 outputFile（JSONL 记录）",
      "通知：XML `<task-notification>` 会被注入到父级会话中",
      "队列：`SendMessage` 会通过 `pendingMessages` 数组把消息投给正在运行的智能体",
      "消息只会在工具轮次边界被排空，不会在执行中途插入",
      "`notified` 标记用于防止重复发送完成通知",
    ],
  },
  coordinator: {
    title: "协调器模式",
    description:
      "管理者-执行者层级。协调器只拥有 3 个工具：`Agent`、`SendMessage`、`TaskStop`。",
    details: [
      "协调器负责思考、规划和拆解任务，本身不直接改代码",
      "worker 拿到的是完整工具集，但不会包含协调类工具",
      "四个阶段：调研 -> 综合 -> 实施 -> 验证",
      "“不要把理解外包出去”——最终综合必须由协调器完成",
      "Scratchpad 通过文件系统让多个 worker 共享知识",
    ],
  },
};

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

function isTerminalStatus(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "killed"
  );
}

// --- Component ---

interface Props {
  className?: string;
}

export default function TaskStateMachine({ className }: Props) {
  const isDark = useDarkMode();
  const [currentStatus, setCurrentStatus] = useState<TaskStatus>("pending");
  const [activeTransition, setActiveTransition] = useState<Transition | null>(
    null
  );
  const [selectedPattern, setSelectedPattern] =
    useState<CommunicationPattern>("foreground");
  const animatingRef = useRef(false);

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    terracotta: "#d97757",
    terracottaBg: isDark
      ? "rgba(217, 119, 87, 0.12)"
      : "rgba(217, 119, 87, 0.08)",
    surfaceBg: isDark ? "#141413" : "#f5f4ed",
    connectorLine: isDark ? "#444" : "#c2c0b6",
  };

  const performTransition = useCallback(
    (transition: Transition) => {
      if (animatingRef.current) return;
      if (transition.from !== currentStatus) return;

      animatingRef.current = true;
      setActiveTransition(transition);

      setTimeout(() => {
        setCurrentStatus(transition.to);
        setTimeout(() => {
          setActiveTransition(null);
          animatingRef.current = false;
        }, 300);
      }, 600);
    },
    [currentStatus]
  );

  const reset = useCallback(() => {
    setCurrentStatus("pending");
    setActiveTransition(null);
    animatingRef.current = false;
  }, []);

  const availableTransitions = transitions.filter(
    (t) => t.from === currentStatus
  );

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* State Machine Diagram */}
      <div
        style={{
          padding: "20px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
          marginBottom: 20,
        }}
      >
        {/* SVG State Diagram */}
        <svg
          viewBox="0 0 580 210"
          style={{ width: "100%", height: "auto", display: "block" }}
        >
          {/* Transition arrows */}
          {transitions.map((t) => {
            const from = statusPositions[t.from];
            const to = statusPositions[t.to];
            const isActive = activeTransition === t;
            const midX = (from.x + to.x) / 2;
            const midY = (from.y + to.y) / 2;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            const offsetX = (dx / len) * 50;
            const offsetY = (dy / len) * 50;

            return (
              <g key={`${t.from}-${t.to}`}>
                <defs>
                  <marker
                    id={`arrow-${t.from}-${t.to}`}
                    markerWidth="8"
                    markerHeight="8"
                    refX="8"
                    refY="4"
                    orient="auto"
                  >
                    <path
                      d="M0,0 L8,4 L0,8"
                      fill={isActive ? colors.terracotta : colors.connectorLine}
                    />
                  </marker>
                </defs>
                <line
                  x1={from.x + offsetX}
                  y1={from.y + offsetY}
                  x2={to.x - offsetX}
                  y2={to.y - offsetY}
                  stroke={isActive ? colors.terracotta : colors.connectorLine}
                  strokeWidth={isActive ? 2.5 : 1.5}
                  markerEnd={`url(#arrow-${t.from}-${t.to})`}
                  style={{ transition: "stroke 0.3s, stroke-width 0.3s" }}
                />
                <text
                  x={midX}
                  y={midY - 10}
                  textAnchor="middle"
                  fill={isActive ? colors.terracotta : colors.textSecondary}
                  fontSize="10"
                  fontFamily="var(--font-mono)"
                  style={{ transition: "fill 0.3s" }}
                >
                  {t.label}
                </text>
              </g>
            );
          })}

          {/* State nodes */}
          {(Object.keys(statusPositions) as TaskStatus[]).map((status) => {
            const pos = statusPositions[status];
            const isCurrent = currentStatus === status;
            const isTarget = activeTransition?.to === status;
            const nodeColor = statusColors[status];
            const isTerminal = isTerminalStatus(status);

            return (
              <g key={status}>
                {/* Glow for current */}
                {isCurrent && (
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={38}
                    fill="none"
                    stroke={nodeColor}
                    strokeWidth="2"
                    opacity="0.3"
                  >
                    <animate
                      attributeName="r"
                      values="38;44;38"
                      dur="2s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0.3;0.1;0.3"
                      dur="2s"
                      repeatCount="indefinite"
                    />
                  </circle>
                )}

                {/* Node circle */}
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={32}
                  fill={
                    isCurrent
                      ? isDark
                        ? `${nodeColor}20`
                        : `${nodeColor}15`
                      : colors.cardBg
                  }
                  stroke={isCurrent || isTarget ? nodeColor : colors.cardBorder}
                  strokeWidth={isCurrent ? 2.5 : 1.5}
                  style={{ transition: "all 0.4s" }}
                />

                {/* Terminal state double circle */}
                {isTerminal && (
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={27}
                    fill="none"
                    stroke={
                      isCurrent || isTarget ? nodeColor : colors.cardBorder
                    }
                    strokeWidth={1}
                    opacity={0.5}
                    style={{ transition: "all 0.4s" }}
                  />
                )}

                <text
                  x={pos.x}
                  y={pos.y + 4}
                  textAnchor="middle"
                  fill={isCurrent ? nodeColor : colors.text}
                  fontSize="11"
                  fontWeight={isCurrent ? "700" : "500"}
                  fontFamily="var(--font-mono)"
                  style={{ transition: "fill 0.3s" }}
                >
                  {statusLabels[status]}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Controls + Transition Info */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          marginBottom: 20,
        }}
      >
        {/* Transition buttons */}
        <div
          style={{
            padding: "16px 20px",
            background: colors.cardBg,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: 12,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: colors.textSecondary,
              marginBottom: 12,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            可用迁移
          </div>

          {availableTransitions.length > 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {availableTransitions.map((t) => (
                <button
                  key={`${t.from}-${t.to}`}
                  onClick={() => performTransition(t)}
                  disabled={animatingRef.current}
                  style={{
                    padding: "10px 16px",
                    borderRadius: 8,
                    border: `1px solid ${statusColors[t.to]}40`,
                    background: `${statusColors[t.to]}10`,
                    color: statusColors[t.to],
                    fontSize: 13,
                    fontWeight: 600,
                    fontFamily: "var(--font-mono)",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background 0.2s",
                  }}
                >
                  {t.label}
                  <span
                    style={{
                      float: "right",
                      opacity: 0.6,
                      fontSize: 11,
                    }}
                  >
                    {statusLabels[t.from]} -&gt; {statusLabels[t.to]}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: colors.textSecondary }}>
              已到达终止状态。
              <button
                onClick={reset}
                style={{
                  display: "block",
                  marginTop: 10,
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "none",
                  background: colors.terracotta,
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                }}
              >
                重置为待执行
              </button>
            </div>
          )}
        </div>

        {/* Transition detail */}
        <div
          style={{
            padding: "16px 20px",
            background: colors.cardBg,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: 12,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: colors.textSecondary,
              marginBottom: 12,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            迁移详情
          </div>

          <AnimatePresence mode="wait">
            {activeTransition ? (
              <motion.div
                key={`${activeTransition.from}-${activeTransition.to}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2 }}
              >
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    fontFamily: "var(--font-mono)",
                    color: colors.terracotta,
                    marginBottom: 8,
                  }}
                >
                  {statusLabels[activeTransition.from]} -&gt; {statusLabels[activeTransition.to]}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: colors.text,
                    marginBottom: 4,
                  }}
                >
                  触发条件：
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: colors.textSecondary,
                    marginBottom: 10,
                  }}
                >
                  {activeTransition.trigger}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: colors.textSecondary,
                    lineHeight: 1.6,
                  }}
                >
                  {activeTransition.detail}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="idle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <div style={{ fontSize: 13, color: colors.textSecondary }}>
                  点击任意迁移，可查看细节并播放状态变化动画。
                </div>
                <div
                  style={{
                    marginTop: 10,
                    padding: "8px 12px",
                    borderRadius: 8,
                    background: colors.surfaceBg,
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    color: colors.textSecondary,
                  }}
                >
                  isTerminalTaskStatus({currentStatus}) ={" "}
                  <span
                    style={{
                      color: isTerminalStatus(currentStatus)
                        ? statusColors.completed
                        : colors.terracotta,
                      fontWeight: 600,
                    }}
                  >
                    {String(isTerminalStatus(currentStatus))}
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Communication Patterns */}
      <div
        style={{
          padding: "16px 20px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: 12,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
            marginBottom: 14,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          通信模式
        </div>

        {/* Tabs */}
        <div
          style={{
            display: "flex",
            gap: 4,
            marginBottom: 16,
            padding: 3,
            background: colors.surfaceBg,
            borderRadius: 8,
            border: `1px solid ${colors.cardBorder}`,
          }}
        >
          {(Object.keys(communicationPatterns) as CommunicationPattern[]).map(
            (pattern) => {
              const isActive = selectedPattern === pattern;
              return (
                <button
                  key={pattern}
                  onClick={() => setSelectedPattern(pattern)}
                  style={{
                    flex: 1,
                    padding: "8px 12px",
                    borderRadius: 6,
                    border: "none",
                    background: isActive ? colors.cardBg : "transparent",
                    color: isActive ? colors.terracotta : colors.textSecondary,
                    fontSize: 12,
                    fontWeight: isActive ? 600 : 400,
                    fontFamily: "var(--font-mono)",
                    cursor: "pointer",
                    transition: "all 0.2s",
                    boxShadow: isActive
                      ? isDark
                        ? "0 1px 3px rgba(0,0,0,0.3)"
                        : "0 1px 3px rgba(0,0,0,0.1)"
                      : "none",
                  }}
                >
                  {communicationPatterns[pattern].title}
                </button>
              );
            }
          )}
        </div>

        {/* Pattern content */}
        <AnimatePresence mode="wait">
          <motion.div
            key={selectedPattern}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: colors.text,
                marginBottom: 8,
              }}
            >
              {communicationPatterns[selectedPattern].description}
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {communicationPatterns[selectedPattern].details.map(
                (detail, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: colors.surfaceBg,
                      border: `1px solid ${colors.cardBorder}`,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                        fontWeight: 700,
                        color: colors.terracotta,
                        minWidth: 18,
                        marginTop: 1,
                      }}
                    >
                      {i + 1}.
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: colors.text,
                        lineHeight: 1.5,
                      }}
                    >
                      {detail}
                    </span>
                  </div>
                )
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
