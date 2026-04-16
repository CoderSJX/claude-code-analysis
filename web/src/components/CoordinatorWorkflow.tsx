import { useState, useEffect } from "react";
import { motion } from "framer-motion";

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

interface Phase {
  name: string;
  description: string;
  detail: string;
  icon: string;
  color: string;
}

const phases: Phase[] = [
  {
    name: "调研",
    description: "理解问题",
    detail: "派出并行智能体探索代码库、阅读文档、分析模式",
    icon: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
    color: "#60a5fa",
  },
  {
    name: "综合",
    description: "整合发现",
    detail: "协调者阅读所有调研结果，建立共同理解，并规划方案",
    icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
    color: "#a78bfa",
  },
  {
    name: "实施",
    description: "执行计划",
    detail: "工作者并行实现，协调者通过 scratchpad 监控进度",
    icon: "M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4",
    color: "#d97757",
  },
  {
    name: "验证",
    description: "确认正确性",
    detail: "运行测试、检查类型、验证行为是否符合需求",
    icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
    color: "#4ade80",
  },
];

interface Props {
  className?: string;
}

export default function CoordinatorWorkflow({ className }: Props) {
  const isDark = useDarkMode();

  const colors = {
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    connector: isDark ? "#555" : "#c2c0b6",
    surfaceBg: isDark ? "#141413" : "#f5f4ed",
  };

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          overflowX: "auto",
          padding: "4px 0",
        }}
      >
        {phases.map((phase, i) => (
          <div
            key={phase.name}
            style={{
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            {/* Phase card */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: i * 0.12 }}
              style={{
                background: colors.cardBg,
                border: `1.5px solid ${colors.cardBorder}`,
                borderRadius: 12,
                padding: "20px 18px",
                width: 160,
                textAlign: "center",
                position: "relative",
              }}
            >
              {/* Phase number badge */}
              <div
                style={{
                  position: "absolute",
                  top: -10,
                  left: "50%",
                  transform: "translateX(-50%)",
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: phase.color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: "var(--font-mono)",
                  color: "#fff",
                }}
              >
                {i + 1}
              </div>

              {/* Icon */}
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: `${phase.color}15`,
                  border: `1px solid ${phase.color}30`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "6px auto 12px",
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={phase.color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={phase.icon} />
                </svg>
              </div>

              {/* Name */}
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: colors.text,
                  marginBottom: 6,
                }}
              >
                {phase.name}
              </div>

              {/* Description */}
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: phase.color,
                  marginBottom: 8,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {phase.description}
              </div>

              {/* Detail */}
              <div
                style={{
                  fontSize: 11,
                  color: colors.textSecondary,
                  lineHeight: 1.5,
                }}
              >
                {phase.detail}
              </div>
            </motion.div>

            {/* Arrow between phases */}
            {i < phases.length - 1 && (
              <motion.svg
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 + i * 0.1, duration: 0.3 }}
                width="36"
                height="20"
                viewBox="0 0 36 20"
                style={{ display: "block", flexShrink: 0 }}
              >
                <line
                  x1={2}
                  y1={10}
                  x2={28}
                  y2={10}
                  stroke={colors.connector}
                  strokeWidth={1.5}
                />
                <polygon points="28,6 36,10 28,14" fill={colors.connector} />
              </motion.svg>
            )}
          </div>
        ))}
      </div>

      {/* Coordinator note */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6, duration: 0.3 }}
        style={{
          marginTop: 16,
          padding: "10px 16px",
          borderRadius: 8,
          background: colors.surfaceBg,
          border: `1px solid ${colors.cardBorder}`,
          textAlign: "center",
          fontSize: 12,
          color: colors.textSecondary,
          fontFamily: "var(--font-mono)",
        }}
      >
        协调者负责思考和规划 - 工作者负责动代码。“绝不把理解外包出去。”
      </motion.div>
    </div>
  );
}
