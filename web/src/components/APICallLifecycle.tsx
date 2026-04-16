import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Dark mode hook ---

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

// --- Data ---

type Provider = "direct" | "bedrock" | "vertex";

interface PromptSection {
  id: string;
  label: string;
  tier: "static" | "boundary" | "dynamic";
  description: string;
  tokenEstimate: string;
  cacheScope: string;
  contents: string[];
}

const PROMPT_SECTIONS: PromptSection[] = [
  {
    id: "identity",
    label: "身份与介绍",
    tier: "static",
    description: "系统身份、角色描述和行为基础",
    tokenEstimate: "~200",
    cacheScope: "global",
    contents: ["你是 Claude Code，一名资深软件工程师……", "核心行为规则与安全准则"],
  },
  {
    id: "behavior",
    label: "系统行为规则",
    tier: "static",
    description: "响应格式、安全约束、拒绝模式",
    tokenEstimate: "~500",
    cacheScope: "global",
    contents: ["工具调用约定", "错误处理规则", "安全与内容政策"],
  },
  {
    id: "tasks",
    label: "任务执行指导",
    tier: "static",
    description: "如何处理多步骤任务、规划与验证",
    tokenEstimate: "~400",
    cacheScope: "global",
    contents: ["任务拆解规则", "验证要求", "何时提问、何时继续"],
  },
  {
    id: "actions",
    label: "行动指导",
    tier: "static",
    description: "工具定义、schema 和使用说明",
    tokenEstimate: "~2,000",
    cacheScope: "global",
    contents: ["Read、Write、Edit、Bash、Glob、Grep 工具 schema", "工具选择启发式", "文件操作规则"],
  },
  {
    id: "tools",
    label: "工具使用说明",
    tier: "static",
    description: "按工具划分的使用模式与限制",
    tokenEstimate: "~3,000",
    cacheScope: "global",
    contents: ["Git 工作流规则", "先搜索再创建", "文件编辑最佳实践"],
  },
  {
    id: "tone",
    label: "语气与风格",
    tier: "static",
    description: "输出格式、简洁规则、沟通风格",
    tokenEstimate: "~300",
    cacheScope: "global",
    contents: ["默认简洁", "不要多余铺垫", "技术表达要精准"],
  },
  {
    id: "efficiency",
    label: "输出效率",
    tier: "static",
    description: "在尽量少输出 Token 的同时保持高可用性",
    tokenEstimate: "~200",
    cacheScope: "global",
    contents: ["避免复述问题", "只展示相关代码", "批量调用工具"],
  },
  {
    id: "boundary",
    label: "=== DYNAMIC BOUNDARY ===",
    tier: "boundary",
    description: "缓存断点：上方内容在所有用户之间全局共享，下方内容按会话隔离。跨越这条边界移动内容会影响整个集群的缓存性能。",
    tokenEstimate: "marker",
    cacheScope: "break",
    contents: ["下面每个条件分支都是一个运行时位，否则会把 Blake2b 前缀哈希变体数量翻倍（2^N）"],
  },
  {
    id: "session",
    label: "会话指导",
    tier: "dynamic",
    description: "会话级行为覆盖与功能开关",
    tokenEstimate: "~300",
    cacheScope: "per-session",
    contents: ["当前权限模式", "启用的功能开关", "会话类型（REPL vs one-shot）"],
  },
  {
    id: "memory",
    label: "记忆（CLAUDE.md）",
    tier: "dynamic",
    description: "从文件系统加载的项目专属指令",
    tokenEstimate: "~2,000-50,000",
    cacheScope: "per-session",
    contents: ["用户的 CLAUDE.md 内容", "项目约定", "自定义规则与偏好"],
  },
  {
    id: "environment",
    label: "环境信息",
    tier: "dynamic",
    description: "Git 状态、工作目录、操作系统、Shell 信息",
    tokenEstimate: "~500",
    cacheScope: "per-session",
    contents: ["Git 分支、状态、最近提交", "工作目录路径", "操作系统与 Shell 版本"],
  },
  {
    id: "language",
    label: "语言偏好",
    tier: "dynamic",
    description: "用户偏好的回复语言",
    tokenEstimate: "~50",
    cacheScope: "per-session",
    contents: ["用用户的语言回复"],
  },
  {
    id: "mcp",
    label: "MCP 指令",
    tier: "dynamic",
    description: "危险：用户专属的 MCP 工具定义。出现时会禁用全局缓存范围，因为 MCP 定义对每个用户都不同。",
    tokenEstimate: "~1,000-10,000",
    cacheScope: "UNCACHED",
    contents: ["MCP 服务器工具定义", "按工具说明", "服务器连接信息"],
  },
  {
    id: "output-style",
    label: "输出风格",
    tier: "dynamic",
    description: "会话级输出格式偏好",
    tokenEstimate: "~100",
    cacheScope: "per-session",
    contents: ["详细模式设置", "展开视图偏好"],
  },
];

const PROVIDER_INFO: Record<Provider, { label: string; authDesc: string; envVar: string; color: string }> = {
  direct: {
    label: "直连 API",
    authDesc: "API key 或 OAuth token",
    envVar: "ANTHROPIC_API_KEY",
    color: "#d97757",
  },
  bedrock: {
    label: "AWS Bedrock",
    authDesc: "AWS 凭证（IAM 角色 / Access Key）",
    envVar: "ANTHROPIC_BEDROCK_BASE_URL",
    color: "#ff9900",
  },
  vertex: {
    label: "Google Vertex AI",
    authDesc: "Google 认证（服务账号 / ADC）",
    envVar: "ANTHROPIC_VERTEX_PROJECT_ID",
    color: "#4285f4",
  },
};

interface ToggleFeature {
  id: string;
  label: string;
  default: boolean;
  effect: string;
}

const TOGGLE_FEATURES: ToggleFeature[] = [
  { id: "extended-thinking", label: "扩展思考", default: false, effect: "向请求体添加思考预算 - 会改变缓存键" },
  { id: "mcp-tools", label: "MCP 工具", default: false, effect: "添加用户专属工具定义 - 禁用全局缓存范围" },
  { id: "auto-mode", label: "自动模式（AFK）", default: false, effect: "添加 beta header - 一旦锁存，整个会话都保持开启" },
];

// --- Component ---

interface Props {
  className?: string;
}

export default function APICallLifecycle({ className }: Props) {
  const isDark = useDarkMode();
  const [selectedProvider, setSelectedProvider] = useState<Provider>("direct");
  const [hoveredSection, setHoveredSection] = useState<string | null>(null);
  const [features, setFeatures] = useState<Record<string, boolean>>({
    "extended-thinking": false,
    "mcp-tools": false,
    "auto-mode": false,
  });

  const colors = {
    terracotta: "#d97757",
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: isDark ? "#87867f" : "#87867f",
    bg: isDark ? "#1e1e1c" : "#ffffff",
    bgCard: isDark ? "#2a2a28" : "#f8f7f2",
    border: isDark ? "#333" : "#c2c0b6",
    // Cache tiers
    staticBg: isDark ? "rgba(34,197,94,0.1)" : "rgba(34,197,94,0.06)",
    staticBorder: isDark ? "rgba(34,197,94,0.3)" : "rgba(34,197,94,0.2)",
    staticAccent: "#22c55e",
    boundaryBg: isDark ? "rgba(217,119,87,0.15)" : "rgba(217,119,87,0.08)",
    boundaryBorder: isDark ? "rgba(217,119,87,0.5)" : "rgba(217,119,87,0.4)",
    dynamicBg: isDark ? "rgba(245,158,11,0.1)" : "rgba(245,158,11,0.06)",
    dynamicBorder: isDark ? "rgba(245,158,11,0.3)" : "rgba(245,158,11,0.2)",
    dynamicAccent: "#f59e0b",
    uncachedBg: isDark ? "rgba(239,68,68,0.1)" : "rgba(239,68,68,0.06)",
    uncachedBorder: isDark ? "rgba(239,68,68,0.3)" : "rgba(239,68,68,0.2)",
    uncachedAccent: "#ef4444",
  };

  const toggleFeature = useCallback((id: string) => {
    setFeatures((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // Compute effective sections based on features
  const effectiveSections = PROMPT_SECTIONS.filter((section) => {
    if (section.id === "mcp" && !features["mcp-tools"]) return false;
    return true;
  });

  // Calculate total tokens for static vs dynamic
  const staticTokens = effectiveSections
    .filter((s) => s.tier === "static")
    .reduce((sum, s) => {
      const match = s.tokenEstimate.match(/[\d,]+/);
      return sum + (match ? parseInt(match[0].replace(",", "")) : 0);
    }, 0);

  const hasMcp = features["mcp-tools"];
  const globalCacheDisabled = hasMcp;

  const getSectionBackground = (section: PromptSection) => {
    if (section.tier === "boundary") return colors.boundaryBg;
    if (section.tier === "static") return colors.staticBg;
    if (section.id === "mcp") return colors.uncachedBg;
    return colors.dynamicBg;
  };

  const getSectionBorder = (section: PromptSection) => {
    if (section.tier === "boundary") return colors.boundaryBorder;
    if (section.tier === "static") return colors.staticBorder;
    if (section.id === "mcp") return colors.uncachedBorder;
    return colors.dynamicBorder;
  };

  const getSectionAccent = (section: PromptSection) => {
    if (section.tier === "boundary") return colors.terracotta;
    if (section.tier === "static") return colors.staticAccent;
    if (section.id === "mcp") return colors.uncachedAccent;
    return colors.dynamicAccent;
  };

  const getCacheScopeLabel = (section: PromptSection) => {
    if (section.tier === "boundary") return "BREAK";
    if (section.tier === "static") {
      return globalCacheDisabled ? "per-session (MCP present)" : "global";
    }
    if (section.id === "mcp") return "UNCACHED";
    return "per-session";
  };

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* Provider selector */}
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "center",
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: 12,
            color: colors.textSecondary,
            fontFamily: "var(--font-mono)",
            alignSelf: "center",
          }}
        >
          Provider:
        </span>
        {(Object.keys(PROVIDER_INFO) as Provider[]).map((provider) => {
          const info = PROVIDER_INFO[provider];
          const isActive = selectedProvider === provider;
          return (
            <button
              key={provider}
              onClick={() => setSelectedProvider(provider)}
              style={{
                background: isActive ? info.color : "transparent",
                color: isActive ? "#fff" : colors.textSecondary,
                border: `1px solid ${isActive ? info.color : colors.border}`,
                borderRadius: 6,
                padding: "4px 12px",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
                transition: "all 0.2s",
              }}
            >
              {info.label}
            </button>
          );
        })}
      </div>

      {/* Provider info strip */}
      <AnimatePresence mode="wait">
        <motion.div
          key={selectedProvider}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.2 }}
          style={{
            textAlign: "center",
            marginBottom: 16,
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
          }}
        >
          Auth: {PROVIDER_INFO[selectedProvider].authDesc} -- env: <code style={{ fontSize: 11, padding: "1px 4px", borderRadius: 3, background: isDark ? "#333" : "#e8e6dc" }}>{PROVIDER_INFO[selectedProvider].envVar}</code>
          <div style={{ fontSize: 11, marginTop: 2, opacity: 0.7 }}>
            All providers are cast to <code style={{ fontSize: 10, padding: "1px 4px", borderRadius: 3, background: isDark ? "#333" : "#e8e6dc" }}>Anthropic</code> via type erasure -- consumers never branch on provider.
          </div>
        </motion.div>
      </AnimatePresence>

      {/* Main layout: prompt stack + details */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 280px",
          gap: 16,
          background: colors.bg,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          padding: 16,
        }}
      >
        {/* Left: Prompt section stack */}
        <div>
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: 1,
              color: colors.textSecondary,
              marginBottom: 10,
            }}
          >
            System Prompt Structure
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {effectiveSections.map((section) => {
              const isHovered = hoveredSection === section.id;
              const accent = getSectionAccent(section);
              const isBoundary = section.tier === "boundary";

              return (
                <motion.div
                  key={section.id}
                  onMouseEnter={() => setHoveredSection(section.id)}
                  onMouseLeave={() => setHoveredSection(null)}
                  animate={{
                    scale: isHovered ? 1.01 : 1,
                    borderColor: isHovered ? accent : getSectionBorder(section),
                  }}
                  transition={{ duration: 0.15 }}
                  style={{
                    background: getSectionBackground(section),
                    border: `1px solid ${getSectionBorder(section)}`,
                    borderRadius: isBoundary ? 0 : 6,
                    padding: isBoundary ? "8px 12px" : "8px 12px",
                    cursor: "pointer",
                    position: "relative",
                    borderLeft: isBoundary ? `3px solid ${colors.terracotta}` : `3px solid ${accent}`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        fontSize: isBoundary ? 11 : 12,
                        fontFamily: "var(--font-mono)",
                        fontWeight: isBoundary ? 700 : 500,
                        color: isBoundary ? colors.terracotta : colors.text,
                        letterSpacing: isBoundary ? 1 : 0,
                      }}
                    >
                      {section.label}
                    </span>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {!isBoundary && (
                        <span
                          style={{
                            fontSize: 10,
                            fontFamily: "var(--font-mono)",
                            color: colors.textSecondary,
                            opacity: 0.8,
                          }}
                        >
                          {section.tokenEstimate}
                        </span>
                      )}
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: "var(--font-mono)",
                          padding: "1px 6px",
                          borderRadius: 3,
                          background: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                          color: accent,
                          fontWeight: 600,
                        }}
                      >
                        {getCacheScopeLabel(section)}
                      </span>
                    </div>
                  </div>

                  {/* Expanded on hover */}
                  <AnimatePresence>
                    {isHovered && !isBoundary && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{ overflow: "hidden" }}
                      >
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 11,
                            color: colors.textSecondary,
                            lineHeight: 1.5,
                          }}
                        >
                          {section.description}
                        </div>
                        <div
                          style={{
                            marginTop: 4,
                            fontSize: 10,
                            fontFamily: "var(--font-mono)",
                            color: colors.textSecondary,
                            opacity: 0.8,
                          }}
                        >
                          {section.contents.map((c, i) => (
                            <div key={i} style={{ paddingLeft: 8, borderLeft: `1px solid ${accent}40`, marginBottom: 2 }}>
                              {c}
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                    {isHovered && isBoundary && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{ overflow: "hidden" }}
                      >
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 11,
                            color: colors.terracotta,
                            lineHeight: 1.5,
                          }}
                        >
                          {section.description}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Right: Info panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Cache indicator */}
          <div
            style={{
              background: colors.bgCard,
              borderRadius: 6,
              padding: "12px 14px",
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: 1,
                color: colors.textSecondary,
                marginBottom: 8,
              }}
            >
              缓存状态
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: globalCacheDisabled ? colors.dynamicAccent : colors.staticAccent,
                }}
              />
              <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: colors.text }}>
                {globalCacheDisabled ? "全局缓存已禁用" : "全局缓存可用"}
              </span>
            </div>
            <div style={{ fontSize: 11, color: colors.textSecondary, lineHeight: 1.5 }}>
              {globalCacheDisabled
                ? "MCP 工具定义是用户专属的，会把全局缓存切碎成数百万个唯一前缀。"
                : `静态区块（约 ${staticTokens.toLocaleString()} 个 token）会在所有 Claude Code 用户、会话和组织之间共享缓存。`}
            </div>
          </div>

          {/* Feature toggles */}
          <div
            style={{
              background: colors.bgCard,
              borderRadius: 6,
              padding: "12px 14px",
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: 1,
                color: colors.textSecondary,
                marginBottom: 8,
              }}
            >
              功能开关
            </div>

            {TOGGLE_FEATURES.map((feature) => {
              const isOn = features[feature.id];
              return (
                <div key={feature.id} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                    <button
                      onClick={() => toggleFeature(feature.id)}
                      style={{
                        width: 36,
                        height: 20,
                        borderRadius: 10,
                        border: "none",
                        cursor: "pointer",
                        position: "relative",
                        background: isOn ? colors.terracotta : (isDark ? "#444" : "#ccc"),
                        transition: "background 0.2s",
                        flexShrink: 0,
                      }}
                    >
                      <motion.div
                        animate={{ x: isOn ? 16 : 0 }}
                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: "50%",
                          background: "#fff",
                          position: "absolute",
                          top: 2,
                          left: 2,
                          boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                        }}
                      />
                    </button>
                    <span style={{ fontSize: 12, color: colors.text }}>{feature.label}</span>
                  </div>
                  <AnimatePresence>
                    {isOn && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{
                          fontSize: 10,
                          fontFamily: "var(--font-mono)",
                          color: colors.terracotta,
                          paddingLeft: 44,
                          lineHeight: 1.4,
                          overflow: "hidden",
                        }}
                      >
                        {feature.effect}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>

          {/* 2^N explanation */}
          <div
            style={{
              background: isDark ? "rgba(217,119,87,0.08)" : "rgba(217,119,87,0.05)",
              border: `1px solid ${isDark ? "rgba(217,119,87,0.2)" : "rgba(217,119,87,0.15)"}`,
              borderRadius: 6,
              padding: "10px 12px",
              fontSize: 11,
              color: colors.textSecondary,
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 600, color: colors.terracotta, marginBottom: 4, fontFamily: "var(--font-mono)", fontSize: 10 }}>
              2^N 问题
            </div>
            边界之前的每一个条件分支都会把唯一全局缓存项的数量翻倍。
            {Object.values(features).filter(Boolean).length > 0 && (
              <span style={{ color: colors.terracotta, fontWeight: 600 }}>
                {" "}当前启用的开关：{Object.values(features).filter(Boolean).length} 个 = {Math.pow(2, Object.values(features).filter(Boolean).length)} 种缓存变体。
              </span>
            )}
            {" "}静态区块刻意保持无条件，以防止缓存碎片化。
          </div>

          {/* Legend */}
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: colors.textSecondary,
              lineHeight: 1.8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 2, background: colors.staticBg, border: `1px solid ${colors.staticBorder}` }} />
              <span>静态（全局缓存）</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 2, background: colors.boundaryBg, border: `1px solid ${colors.boundaryBorder}` }} />
              <span>动态边界</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 2, background: colors.dynamicBg, border: `1px solid ${colors.dynamicBorder}` }} />
              <span>动态（按会话）</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 2, background: colors.uncachedBg, border: `1px solid ${colors.uncachedBorder}` }} />
              <span>未缓存（危险）</span>
            </div>
          </div>

          {/* Hover hint */}
          <div
            style={{
              textAlign: "center",
              fontSize: 11,
              color: colors.textSecondary,
              fontStyle: "italic",
            }}
          >
            悬停在区块上查看详情
          </div>
        </div>
      </div>

      {/* DANGEROUS naming convention callout */}
      <div
        style={{
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
        }}
      >
        <div
          style={{
            background: colors.bgCard,
            borderRadius: 6,
            padding: "10px 12px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 600, color: colors.staticAccent, marginBottom: 4 }}>
            systemPromptSection()
          </div>
          安全。内容放在边界之前，全局缓存，不允许运行时条件分支。
        </div>
        <div
          style={{
            background: colors.bgCard,
            borderRadius: 6,
            padding: "10px 12px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: colors.textSecondary,
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 600, color: colors.uncachedAccent, marginBottom: 4 }}>
            DANGEROUS_uncachedSystemPromptSection(_reason)
          </div>
          会破坏缓存。需要提供 reason 字符串。源码文档中要求 _reason 参数必须填写。
        </div>
      </div>
    </div>
  );
}
