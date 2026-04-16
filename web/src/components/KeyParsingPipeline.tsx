import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

interface PipelineStage {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
}

interface KeyPreset {
  name: string;
  rawBytes: string;
  hexBytes: string[];
  protocol: string;
  parsedKey: {
    key: string;
    ctrl: boolean;
    shift: boolean;
    meta: boolean;
  };
  matchedContext: string;
  isChord: boolean;
  chordSecond?: {
    rawBytes: string;
    hexBytes: string[];
    parsedKey: {
      key: string;
      ctrl: boolean;
      shift: boolean;
      meta: boolean;
    };
  };
  action: string;
  actionDescription: string;
}

// --- Data ---

const stages: PipelineStage[] = [
  {
    id: "stdin",
    label: "stdin 原始字节",
    shortLabel: "字节",
    description:
      "原始字节从终端进入。一次 `read()` 可能拿到完整的 escape sequence，也可能只拿到残片。tokenizer 会用 50ms 超时窗口缓存未完成的序列。",
  },
  {
    id: "protocol",
    label: "协议识别",
    shortLabel: "协议",
    description:
      "对字节序列做分类：Kitty keyboard protocol（CSI u）、xterm modifyOtherKeys（CSI 27;mod;key~）、传统 VT220、SGR 鼠标事件或 bracketed paste。",
  },
  {
    id: "parse",
    label: "序列解析",
    shortLabel: "解析",
    description:
      "把 escape sequence 解析成按键身份与修饰键。遵循 XTerm 约定：`modifier = 1 + (shift?1:0) + (alt?2:0) + (ctrl?4:0) + (super?8:0)`。",
  },
  {
    id: "event",
    label: "按键事件生成",
    shortLabel: "事件",
    description:
      "生成结构化的 `ParsedKey` 对象：`{ kind: 'key', name, ctrl, meta, shift, option, super, sequence, isPasted }`，所有歧义都会在这里被消除。",
  },
  {
    id: "binding",
    label: "按键绑定查找",
    shortLabel: "绑定",
    description:
      "在 16 个活动上下文合并后的绑定表里查找匹配项。最后匹配到的绑定生效，用户覆盖优先。上下文列表会在每次按键时重新计算。",
  },
  {
    id: "chord",
    label: "组合键处理",
    shortLabel: "组合",
    description:
      "如果这是一个组合键的前半段，系统会等待最多 1000ms 来接收第二段。等待期间 `ChordInterceptor` 会接管所有输入。取消的组合键会丢弃前缀，但不会吞掉不匹配的后续字符。",
  },
  {
    id: "action",
    label: "动作分发",
    shortLabel: "动作",
    description:
      "执行已绑定的动作处理器。`stopImmediatePropagation()` 会阻止后续继续处理，而 React 会把随后的状态更新统一批量提交。",
  },
];

const keybindingContexts = [
  "全局",
  "聊天",
  "自动补全",
  "确认弹窗",
  "滚动",
  "对话记录",
  "历史搜索",
  "任务",
  "帮助",
  "消息选择器",
  "消息操作",
  "Diff 对话框",
  "选择",
  "设置",
  "标签页",
  "底栏",
];

const presets: KeyPreset[] = [
  {
    name: "Ctrl+C",
    rawBytes: "\\x03",
    hexBytes: ["03"],
    protocol: "Control character (legacy)",
    parsedKey: { key: "c", ctrl: true, shift: false, meta: false },
    matchedContext: "全局",
    isChord: false,
    action: "app:interrupt",
    actionDescription: "中断当前操作或退出",
  },
  {
    name: "上箭头",
    rawBytes: "\\x1b[A",
    hexBytes: ["1b", "5b", "41"],
    protocol: "Legacy VT220 (CSI sequence)",
    parsedKey: { key: "ArrowUp", ctrl: false, shift: false, meta: false },
    matchedContext: "聊天",
    isChord: false,
    action: "history:previous",
    actionDescription: "切换到上一条历史记录",
  },
  {
    name: "Ctrl+Up",
    rawBytes: "\\x1b[1;5A",
    hexBytes: ["1b", "5b", "31", "3b", "35", "41"],
    protocol: "xterm modifyOtherKeys",
    parsedKey: { key: "ArrowUp", ctrl: true, shift: false, meta: false },
    matchedContext: "滚动",
    isChord: false,
    action: "scroll:pageUp",
    actionDescription: "向上翻一页",
  },
  {
    name: "Escape",
    rawBytes: "\\x1b",
    hexBytes: ["1b"],
    protocol: "Ambiguous (50ms timeout to distinguish from CSI prefix)",
    parsedKey: { key: "escape", ctrl: false, shift: false, meta: false },
    matchedContext: "聊天",
    isChord: false,
    action: "chat:cancel",
    actionDescription: "取消当前输入或当前操作",
  },
  {
    name: "Ctrl+X Ctrl+K",
    rawBytes: "\\x18",
    hexBytes: ["18"],
    protocol: "Control character (ASCII CAN)",
    parsedKey: { key: "x", ctrl: true, shift: false, meta: false },
    matchedContext: "聊天",
    isChord: true,
    chordSecond: {
      rawBytes: "\\x0b",
      hexBytes: ["0b"],
      parsedKey: { key: "k", ctrl: true, shift: false, meta: false },
    },
    action: "chat:killAgents",
    actionDescription: "终止所有正在运行的子智能体",
  },
  {
    name: "Ctrl+R",
    rawBytes: "\\x12",
    hexBytes: ["12"],
    protocol: "Control character (ASCII DC2)",
    parsedKey: { key: "r", ctrl: true, shift: false, meta: false },
    matchedContext: "全局",
    isChord: false,
    action: "history:search",
    actionDescription: "打开反向历史搜索",
  },
];

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

function formatModifiers(key: {
  key: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}): string {
  const parts: string[] = [];
  if (key.ctrl) parts.push("ctrl");
  if (key.shift) parts.push("shift");
  if (key.meta) parts.push("alt");
  parts.push(key.key);
  return parts.join(" + ");
}

// --- Component ---

interface Props {
  className?: string;
}

export default function KeyParsingPipeline({ className }: Props) {
  const isDark = useDarkMode();
  const [selectedPreset, setSelectedPreset] = useState<KeyPreset | null>(null);
  const [activeStageIndex, setActiveStageIndex] = useState(-1);
  const [isAnimating, setIsAnimating] = useState(false);
  const [chordWaiting, setChordWaiting] = useState(false);
  const [chordCountdown, setChordCountdown] = useState(1000);
  const animatingRef = useRef(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    terracotta: "#d97757",
    terracottaBg: isDark
      ? "rgba(217, 119, 87, 0.15)"
      : "rgba(217, 119, 87, 0.08)",
    surfaceBg: isDark ? "#141413" : "#f5f4ed",
    inputBg: isDark ? "#2a2a28" : "#f5f4ed",
    connectorLine: isDark ? "#444" : "#c2c0b6",
    stageBg: isDark ? "#252523" : "#fafaf7",
    stageActiveBg: isDark
      ? "rgba(217, 119, 87, 0.12)"
      : "rgba(217, 119, 87, 0.06)",
    highlight: "#eda100",
    highlightBg: isDark
      ? "rgba(237, 161, 0, 0.12)"
      : "rgba(237, 161, 0, 0.06)",
    green: "#4ade80",
    greenBg: isDark
      ? "rgba(74, 222, 128, 0.12)"
      : "rgba(74, 222, 128, 0.06)",
  };

  const runAnimation = useCallback(
    (preset: KeyPreset) => {
      if (animatingRef.current) return;
      animatingRef.current = true;
      setIsAnimating(true);
      setSelectedPreset(preset);
      setActiveStageIndex(-1);
      setChordWaiting(false);

      let currentStage = 0;
      const advanceStage = () => {
        if (currentStage >= stages.length) {
          // Done
          setTimeout(() => {
            setIsAnimating(false);
            animatingRef.current = false;
          }, 800);
          return;
        }

        setActiveStageIndex(currentStage);

        // Chord handling: pause at stage 5 if chord
        if (currentStage === 5 && preset.isChord) {
          setChordWaiting(true);
          setChordCountdown(1000);

          let ms = 1000;
          countdownRef.current = setInterval(() => {
            ms -= 50;
            setChordCountdown(Math.max(0, ms));
            if (ms <= 200) {
              if (countdownRef.current) clearInterval(countdownRef.current);
              setChordWaiting(false);
              currentStage++;
              setTimeout(advanceStage, 300);
            }
          }, 50);
          return;
        }

        currentStage++;
        setTimeout(advanceStage, 500);
      };

      // Start with a small delay
      setTimeout(advanceStage, 200);
    },
    []
  );

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  const reset = useCallback(() => {
    setSelectedPreset(null);
    setActiveStageIndex(-1);
    setIsAnimating(false);
    setChordWaiting(false);
    animatingRef.current = false;
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  // Determine stage-specific display data
  function getStageData(stageIndex: number): string | null {
    if (!selectedPreset || activeStageIndex < stageIndex) return null;

    switch (stageIndex) {
      case 0:
        return selectedPreset.hexBytes.map((h) => `0x${h}`).join(" ");
      case 1:
        return selectedPreset.protocol;
      case 2:
        return formatModifiers(selectedPreset.parsedKey);
      case 3:
        return `{ key: "${selectedPreset.parsedKey.key}", ctrl: ${selectedPreset.parsedKey.ctrl}, shift: ${selectedPreset.parsedKey.shift} }`;
      case 4:
        return `Context: ${selectedPreset.matchedContext}`;
      case 5:
        return selectedPreset.isChord
          ? chordWaiting
            ? "Waiting for second keystroke..."
            : `Chord complete: ${selectedPreset.name}`
          : "No chord -- pass through";
      case 6:
        return `${selectedPreset.action}`;
      default:
        return null;
    }
  }

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Header */}
      <div
        style={{
          padding: "16px 20px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: "12px 12px 0 0",
          borderBottom: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: colors.terracotta,
            }}
          />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              color: colors.terracotta,
              fontWeight: 600,
            }}
          >
            按键解析流水线
          </span>
          <span
            style={{
              fontSize: 12,
              color: colors.textSecondary,
            }}
          >
            第 14 章 · 输入与交互
          </span>
        </div>
        {(selectedPreset || activeStageIndex >= 0) && (
          <button
            onClick={reset}
            style={{
              padding: "5px 12px",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              background: "transparent",
              color: colors.textSecondary,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            重置
          </button>
        )}
      </div>

      {/* Presets */}
      <div
        style={{
          padding: "12px 20px 16px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderTop: "none",
          borderBottom: "none",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: colors.textSecondary,
            marginBottom: 8,
          }}
        >
          按下一个键，或者直接选择一个预设：
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {presets.map((preset) => (
            <button
              key={preset.name}
              onClick={() => runAnimation(preset)}
              disabled={isAnimating}
              style={{
                padding: "7px 14px",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                fontWeight: 600,
                background:
                  selectedPreset?.name === preset.name
                    ? colors.terracottaBg
                    : colors.stageBg,
                color:
                  selectedPreset?.name === preset.name
                    ? colors.terracotta
                    : colors.text,
                border: `1px solid ${
                  selectedPreset?.name === preset.name
                    ? colors.terracotta
                    : colors.cardBorder
                }`,
                borderRadius: 6,
                cursor: isAnimating ? "not-allowed" : "pointer",
                opacity: isAnimating && selectedPreset?.name !== preset.name ? 0.4 : 1,
                transition: "all 0.15s",
              }}
            >
              {preset.name}
              {preset.isChord && (
                <span
                  style={{
                    fontSize: 9,
                    marginLeft: 4,
                    opacity: 0.6,
                  }}
                >
                    （组合键）
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Pipeline stages */}
      <div
        style={{
          padding: "16px 20px",
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: "0 0 12px 12px",
          overflowX: "auto",
        }}
      >
        {/* Horizontal pipeline */}
        <div
          style={{
            display: "flex",
            gap: 0,
            minWidth: "fit-content",
            alignItems: "stretch",
          }}
        >
          {stages.map((stage, index) => {
            const isActive = activeStageIndex === index;
            const isPassed = activeStageIndex > index;
            const isNotReached = activeStageIndex < index;
            const stageData = getStageData(index);

            const isChordStage = index === 5 && selectedPreset?.isChord;

            let bg = colors.stageBg;
            let borderColor = colors.cardBorder;
            if (isActive) {
              bg = isChordStage && chordWaiting
                ? colors.highlightBg
                : colors.stageActiveBg;
              borderColor = isChordStage && chordWaiting
                ? colors.highlight
                : colors.terracotta;
            } else if (isPassed) {
              bg = colors.greenBg;
              borderColor = colors.green;
            }

            return (
              <div
                key={stage.id}
                style={{
                  display: "flex",
                  alignItems: "stretch",
                }}
              >
                {/* Arrow connector */}
                {index > 0 && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "0 2px",
                    }}
                  >
                    <svg width="20" height="24" viewBox="0 0 20 24">
                      <path
                        d="M2 12h14M12 7l4 5-4 5"
                        stroke={
                          isPassed
                            ? colors.green
                            : isActive
                            ? colors.terracotta
                            : colors.connectorLine
                        }
                        strokeWidth="1.5"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ transition: "stroke 0.3s" }}
                      />
                    </svg>
                  </div>
                )}

                {/* Stage box */}
                <motion.div
                  animate={{ borderColor }}
                  transition={{ duration: 0.3 }}
                  style={{
                    width: 130,
                    padding: "10px 12px",
                    background: bg,
                    border: `1.5px solid ${borderColor}`,
                    borderRadius: 8,
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    opacity: isNotReached && activeStageIndex >= 0 ? 0.35 : 1,
                    transition: "opacity 0.3s, background 0.3s",
                    position: "relative",
                  }}
                >
                  {/* Stage number */}
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      color: isActive
                        ? colors.terracotta
                        : isPassed
                        ? colors.green
                        : colors.textSecondary,
                      textTransform: "uppercase",
                      letterSpacing: "0.5px",
                      transition: "color 0.3s",
                    }}
                  >
                    Stage {index + 1}
                  </div>

                  {/* Stage label */}
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      fontWeight: 600,
                      color: isActive
                        ? colors.terracotta
                        : isPassed
                        ? colors.text
                        : colors.text,
                      lineHeight: 1.3,
                    }}
                  >
                    {stage.shortLabel}
                  </div>

                  {/* Stage data */}
                  <AnimatePresence>
                    {stageData && (isActive || isPassed) && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 9,
                          lineHeight: 1.4,
                          color: isActive
                            ? colors.terracotta
                            : colors.textSecondary,
                          wordBreak: "break-all",
                          overflow: "hidden",
                        }}
                      >
                        {stageData}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Chord countdown */}
                  {isActive && isChordStage && chordWaiting && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        fontWeight: 700,
                        color: colors.highlight,
                        textAlign: "center",
                        marginTop: 2,
                      }}
                    >
                      {chordCountdown}ms
                    </motion.div>
                  )}

                  {/* Active spinner */}
                  {isActive && !chordWaiting && (
                    <motion.div
                      style={{
                        position: "absolute",
                        top: 8,
                        right: 8,
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: colors.terracotta,
                      }}
                      animate={{ opacity: [1, 0.3, 1] }}
                      transition={{
                        duration: 0.8,
                        repeat: Infinity,
                      }}
                    />
                  )}

                  {/* Passed check */}
                  {isPassed && (
                    <div
                      style={{
                        position: "absolute",
                        top: 8,
                        right: 8,
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10">
                        <path
                          d="M2 5l2 2 4-4"
                          stroke={colors.green}
                          strokeWidth="1.5"
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                  )}
                </motion.div>
              </div>
            );
          })}
        </div>

        {/* Active stage description */}
        <AnimatePresence mode="wait">
          {activeStageIndex >= 0 && activeStageIndex < stages.length && (
            <motion.div
              key={activeStageIndex}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              style={{
                marginTop: 12,
                padding: "10px 14px",
                background: colors.stageBg,
                borderRadius: 6,
                border: `1px solid ${colors.cardBorder}`,
                fontSize: 12,
                color: colors.textSecondary,
                lineHeight: 1.5,
              }}
            >
              {stages[activeStageIndex].description}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom row: Context grid + Result */}
      <div
        style={{
          display: "flex",
          gap: 16,
          marginTop: 16,
          flexWrap: "wrap",
        }}
      >
        {/* Keybinding contexts grid */}
        <div
          style={{
            flex: "1 1 300px",
            padding: "14px 18px",
            background: colors.cardBg,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: 12,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: colors.textSecondary,
              marginBottom: 10,
            }}
          >
            16 Keybinding Contexts
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 4,
            }}
          >
            {keybindingContexts.map((ctx) => {
              const isMatched =
                selectedPreset?.matchedContext === ctx && activeStageIndex >= 4;

              return (
                <motion.div
                  key={ctx}
                  animate={{
                    background: isMatched ? colors.terracottaBg : colors.stageBg,
                    borderColor: isMatched
                      ? colors.terracotta
                      : colors.cardBorder,
                  }}
                  transition={{ duration: 0.3 }}
                  style={{
                    padding: "4px 6px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 9,
                    textAlign: "center",
                    borderRadius: 4,
                    border: `1px solid ${colors.cardBorder}`,
                    color: isMatched ? colors.terracotta : colors.textSecondary,
                    fontWeight: isMatched ? 700 : 400,
                    background: colors.stageBg,
                    transition: "color 0.3s",
                  }}
                >
                  {ctx}
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Final action result */}
        <AnimatePresence>
          {selectedPreset && activeStageIndex >= 6 && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              style={{
                flex: "0 1 260px",
                padding: "14px 18px",
                background: colors.cardBg,
                border: `1px solid ${colors.terracotta}`,
                borderRadius: 12,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: colors.textSecondary,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  marginBottom: 6,
                }}
              >
                Action Dispatched
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 16,
                  fontWeight: 700,
                  color: colors.terracotta,
                  marginBottom: 4,
                }}
              >
                {selectedPreset.action}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: colors.textSecondary,
                  lineHeight: 1.4,
                }}
              >
                {selectedPreset.actionDescription}
              </div>

              {/* Raw -> Parsed summary */}
              <div
                style={{
                  marginTop: 12,
                  padding: "8px 10px",
                  background: colors.stageBg,
                  borderRadius: 6,
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: colors.textSecondary,
                  lineHeight: 1.6,
                }}
              >
                <div>
                  <span style={{ color: colors.text }}>Raw:</span>{" "}
                  {selectedPreset.rawBytes}
                  {selectedPreset.chordSecond &&
                    ` + ${selectedPreset.chordSecond.rawBytes}`}
                </div>
                <div>
                  <span style={{ color: colors.text }}>Hex:</span>{" "}
                  {selectedPreset.hexBytes
                    .map((h) => `0x${h}`)
                    .join(" ")}
                  {selectedPreset.chordSecond &&
                    ` + ${selectedPreset.chordSecond.hexBytes.map((h) => `0x${h}`).join(" ")}`}
                </div>
                <div>
                  <span style={{ color: colors.text }}>Parsed:</span>{" "}
                  {formatModifiers(selectedPreset.parsedKey)}
                  {selectedPreset.chordSecond &&
                    ` -> ${formatModifiers(selectedPreset.chordSecond.parsedKey)}`}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
