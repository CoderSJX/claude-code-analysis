import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---

type View = "grid" | "decision" | "oauth";

interface TransportType {
  id: string;
  name: string;
  category: string;
  categoryColor: string;
  description: string;
  howItWorks: string;
  whenToUse: string;
  connectionFlow: string[];
}

interface DecisionNode {
  id: string;
  question: string;
  options: { label: string; next: string }[];
  result?: string;
  resultTransport?: string;
}

interface OAuthStep {
  id: number;
  title: string;
  description: string;
  detail: string;
}

// --- Data ---

const transports: TransportType[] = [
  {
    id: "stdio",
    name: "stdio",
    category: "本地",
    categoryColor: "#4ade80",
    description: "通过 stdin/stdout 传输 JSON-RPC 的子进程。省略 type 时的默认方式。",
    howItWorks: "Claude Code 会拉起一个子进程。JSON-RPC 消息通过 stdin（客户端到服务器）和 stdout（服务器到客户端）管道传输。无需网络，也无需认证。",
    whenToUse: "本地工具：文件系统访问、数据库查询、自定义脚本。这是最常见的传输方式。",
    connectionFlow: ["启动子进程", "连接 stdin/stdout", "发送 tools/list", "就绪"],
  },
  {
    id: "sse",
    name: "SSE (Server-Sent Events)",
    category: "远程",
    categoryColor: "#60a5fa",
    description: "旧版 HTTP 传输。客户端发起 POST 请求，服务器通过 SSE 流推送响应。",
    howItWorks: "客户端为服务器到客户端的消息建立 SSE 连接。客户端到服务器的消息通过 HTTP POST 发送。虽然部署广泛，但正在被替代。",
    whenToUse: "2025 年之前部署的旧 MCP 服务器。生态中仍然常见。",
    connectionFlow: ["HTTP GET /sse", "建立 SSE 流", "发送 POST 请求", "接收 SSE 响应"],
  },
  {
    id: "http",
    name: "Streamable HTTP",
    category: "远程",
    categoryColor: "#60a5fa",
    description: "当前规范推荐。通过 POST 发送，流式响应时可选 SSE。",
    howItWorks: "客户端通过 HTTP POST 发送 JSON-RPC。服务器可以返回 JSON（简单模式），也可以升级为 SSE 流（流式模式）。通过 session ID 实现双向关联。",
    whenToUse: "新的远程 MCP 服务器。这是当前规范推荐方式。",
    connectionFlow: ["POST /mcp", "返回 JSON 或 SSE", "跟踪 session ID", "遇到 -32001 重试"],
  },
  {
    id: "ws",
    name: "WebSocket",
    category: "远程",
    categoryColor: "#60a5fa",
    description: "全双工双向通信。实际中较少见。",
    howItWorks: "标准 WebSocket 连接。JSON-RPC 消息双向流动。Bun 和 Node 的 WebSocket API 不同，因此需要按运行时分支处理。",
    whenToUse: "需要服务器发起双向通信时。IDE 集成之外很少使用。",
    connectionFlow: ["WS 握手", "双向通道", "双向 JSON-RPC", "断开时关闭"],
  },
  {
    id: "sdk",
    name: "SDK Transport",
    category: "进程内",
    categoryColor: "#a78bfa",
    description: "在 SDK 嵌入场景中通过 stdin/stdout 传递控制消息。",
    howItWorks: "当 Claude Code 作为 SDK 的子进程运行时使用。控制消息（MCP 请求）会复用与智能体通信相同的 stdin/stdout 通道。",
    whenToUse: "通过官方 SDK 基于 Claude Code 构建时。",
    connectionFlow: ["SDK 启动 Claude Code", "复用控制消息", "通过 stdin/stdout 传递 MCP", "共享通道"],
  },
  {
    id: "sse-ide",
    name: "IDE stdio",
    category: "IDE",
    categoryColor: "#f472b6",
    description: "通过 stdio 通道通信的 VS Code 或 JetBrains 扩展。",
    howItWorks: "IDE 扩展通过自己的扩展 API 提供 MCP 服务器。通信使用 IDE 内建的 stdio 通道，而不是网络。",
    whenToUse: "通过 IDE 原生通道暴露 MCP 工具的 VS Code 扩展。",
    connectionFlow: ["加载 IDE 扩展", "打开 stdio 通道", "MCP 握手", "工具就绪"],
  },
  {
    id: "ws-ide",
    name: "IDE WebSocket",
    category: "IDE",
    categoryColor: "#f472b6",
    description: "通过 WebSocket 连接的 IDE 远程连接。依赖运行时（Bun 或 Node）。",
    howItWorks: "连接到远程运行的 IDE 扩展。Bun 的 WebSocket 原生支持代理/TLS；Node 需要 `ws` 包。",
    whenToUse: "远程 IDE 连接（例如 JetBrains Gateway、VS Code Remote）。",
    connectionFlow: ["WS 连接 IDE", "检测运行时", "Bun 原生 / Node ws", "MCP 就绪"],
  },
  {
    id: "inprocess",
    name: "In-Process",
    category: "进程内",
    categoryColor: "#a78bfa",
    description: "成对链接的传输。直接函数调用。总共 63 行。",
    howItWorks: "两个 InProcessTransport 实例作为对等节点链接。send() 通过 queueMicrotask() 递送，避免栈深问题。close() 会级联到对端。",
    whenToUse: "同进程 MCP 服务器：Chrome MCP、Computer Use MCP。零网络开销。",
    connectionFlow: ["创建链接对", "queueMicrotask 递送", "直接函数调用", "级联关闭"],
  },
];

const decisionTree: DecisionNode[] = [
  {
    id: "start",
    question: "你的 MCP 服务器在哪里？",
    options: [
      { label: "同一台机器（本地进程）", next: "local" },
      { label: "远程服务（HTTP/WS）", next: "remote" },
      { label: "同一进程（嵌入式）", next: "inprocess" },
      { label: "IDE 扩展", next: "ide" },
    ],
  },
  {
    id: "local",
    question: "",
    options: [],
    result: "使用 stdio -- 无网络、无认证，只有管道。默认且最常见的传输方式。",
    resultTransport: "stdio",
  },
  {
    id: "remote",
    question: "服务器需要流式响应吗？",
    options: [
      { label: "是，需要流式响应", next: "remote-stream" },
      { label: "否，普通请求 / 响应即可", next: "remote-simple" },
      { label: "需要完整双向通信", next: "remote-bidi" },
    ],
  },
  {
    id: "remote-stream",
    question: "服务器是旧版（2025 年前）部署吗？",
    options: [
      { label: "是，旧版服务器", next: "remote-legacy" },
      { label: "否，新服务器", next: "remote-new" },
    ],
  },
  {
    id: "remote-legacy",
    question: "",
    options: [],
    result: "使用 SSE -- 虽然是旧方案，但部署广泛。服务器通过 Server-Sent Events 推送响应。",
    resultTransport: "sse",
  },
  {
    id: "remote-new",
    question: "",
    options: [],
    result: "使用 Streamable HTTP -- 当前规范推荐。通过 POST 发送，可选升级到 SSE。",
    resultTransport: "http",
  },
  {
    id: "remote-simple",
    question: "",
    options: [],
    result: "使用 Streamable HTTP -- 也适用于简单 JSON 响应。远程场景下的规范默认值。",
    resultTransport: "http",
  },
  {
    id: "remote-bidi",
    question: "",
    options: [],
    result: "使用 WebSocket -- 全双工双向通信。注意：Bun/Node 运行时需要分别处理 ws 包。",
    resultTransport: "ws",
  },
  {
    id: "inprocess",
    question: "服务器是用 MCP SDK 构建的吗？",
    options: [
      { label: "是，基于 SDK", next: "inprocess-sdk" },
      { label: "否，同进程自定义服务器", next: "inprocess-linked" },
    ],
  },
  {
    id: "inprocess-sdk",
    question: "",
    options: [],
    result: "使用 SDK 传输 -- 在现有 stdin/stdout 通道上复用 MCP。",
    resultTransport: "sdk",
  },
  {
    id: "inprocess-linked",
    question: "",
    options: [],
    result: "使用 InProcessTransport -- 链接成对，并通过 queueMicrotask 递送。仅 63 行。",
    resultTransport: "inprocess",
  },
  {
    id: "ide",
    question: "IDE 是本地还是远程？",
    options: [
      { label: "本地 IDE（VS Code、JetBrains）", next: "ide-local" },
      { label: "远程 IDE（Gateway、Remote SSH）", next: "ide-remote" },
    ],
  },
  {
    id: "ide-local",
    question: "",
    options: [],
    result: "使用 IDE stdio -- 通过 IDE 内建扩展通道通信。",
    resultTransport: "sse-ide",
  },
  {
    id: "ide-remote",
    question: "",
    options: [],
    result: "使用 IDE WebSocket -- 进行远程连接，并处理 Bun/Node 运行时差异。",
    resultTransport: "ws-ide",
  },
];

const oauthSteps: OAuthStep[] = [
  {
    id: 1,
    title: "服务器返回 401",
    description: "MCP 服务器需要认证",
    detail: "对 MCP 服务器的初始请求返回 HTTP 401 未授权，这会触发 OAuth 发现链。",
  },
  {
    id: 2,
    title: "RFC 9728 发现",
    description: "探测 /.well-known/oauth-protected-resource",
    detail: "向服务器的 well-known 端点发起 GET 请求。如果找到，则提取 authorization_servers[0]，再针对该 URL 继续 RFC 8414 发现。",
  },
  {
    id: 3,
    title: "RFC 8414 元数据",
    description: "发现授权服务器元数据",
    detail: "获取 OpenID/OAuth 元数据文档。内容包括 token_endpoint、authorization_endpoint、支持的 scope 以及 PKCE 要求。找不到时会回退到路径感知探测。",
  },
  {
    id: 4,
    title: "OAuth 2.0 + PKCE 流程",
    description: "基于浏览器的授权与 code verifier",
    detail: "PKCE（Proof Key for Code Exchange）可防止授权码被截获。生成 code_verifier、计算 code_challenge、跳转用户授权，再交换 code 获取 token。",
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

// --- Component ---

interface Props {
  className?: string;
}

export default function MCPTransports({ className }: Props) {
  const isDark = useDarkMode();
  const [view, setView] = useState<View>("grid");
  const [selectedTransport, setSelectedTransport] = useState<string | null>(null);
  const [decisionPath, setDecisionPath] = useState<string[]>(["start"]);
  const [activeOAuthStep, setActiveOAuthStep] = useState<number | null>(null);

  const colors = {
    accent: "#d97757",
    accentBg: isDark ? "rgba(217, 119, 87, 0.08)" : "rgba(217, 119, 87, 0.05)",
    accentBorder: "rgba(217, 119, 87, 0.5)",
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: "#87867f",
    cardBg: isDark ? "#1e1e1c" : "#ffffff",
    cardBorder: isDark ? "#333" : "#e8e6dc",
    surfaceBg: isDark ? "#30302e" : "#f5f4ed",
    green: "#4ade80",
    greenBg: isDark ? "rgba(74, 222, 128, 0.1)" : "rgba(74, 222, 128, 0.08)",
  };

  const currentDecisionNode = decisionTree.find(
    (n) => n.id === decisionPath[decisionPath.length - 1]
  );

  const advanceDecision = useCallback(
    (nextId: string) => {
      setDecisionPath((prev) => [...prev, nextId]);
    },
    []
  );

  const resetDecision = useCallback(() => {
    setDecisionPath(["start"]);
  }, []);

  const goBackDecision = useCallback(() => {
    setDecisionPath((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  return (
    <div className={className} style={{ fontFamily: "var(--font-serif)" }}>
      {/* View tabs */}
      <div
        style={{
          display: "flex",
          gap: 0,
          marginBottom: 24,
          borderBottom: `1px solid ${colors.cardBorder}`,
        }}
      >
        {([
          { id: "grid" as View, label: "8 Transports" },
          { id: "decision" as View, label: "Which Should I Use?" },
          { id: "oauth" as View, label: "OAuth Discovery" },
        ]).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setView(tab.id)}
            style={{
              padding: "12px 20px",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              background: "none",
              border: "none",
              borderBottom:
                view === tab.id
                  ? `2px solid ${colors.accent}`
                  : "2px solid transparent",
              color: view === tab.id ? colors.accent : colors.textSecondary,
              cursor: "pointer",
              transition: "all 0.2s",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {view === "grid" && (
          <motion.div
            key="grid"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            <TransportGrid
              colors={colors}
              isDark={isDark}
              selectedTransport={selectedTransport}
              setSelectedTransport={setSelectedTransport}
            />
          </motion.div>
        )}
        {view === "decision" && (
          <motion.div
            key="decision"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            <DecisionTree
              colors={colors}
              isDark={isDark}
              currentNode={currentDecisionNode!}
              path={decisionPath}
              onAdvance={advanceDecision}
              onReset={resetDecision}
              onBack={goBackDecision}
            />
          </motion.div>
        )}
        {view === "oauth" && (
          <motion.div
            key="oauth"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            <OAuthFlow
              colors={colors}
              isDark={isDark}
              activeStep={activeOAuthStep}
              setActiveStep={setActiveOAuthStep}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Transport Grid ---

function TransportGrid({
  colors,
  isDark,
  selectedTransport,
  setSelectedTransport,
}: {
  colors: Record<string, string>;
  isDark: boolean;
  selectedTransport: string | null;
  setSelectedTransport: (id: string | null) => void;
}) {
  const categories = ["Local", "Remote", "In-Process", "IDE"];

  return (
    <div>
      {/* Category legend */}
      <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        {categories.map((cat) => {
          const t = transports.find((tr) => tr.category === cat);
          return (
            <div key={cat} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: t?.categoryColor || "#888",
                }}
              />
              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: colors.textSecondary }}>
                {cat}
              </span>
            </div>
          );
        })}
      </div>

      {/* Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          gap: 10,
          marginBottom: 16,
        }}
      >
        {transports.map((transport) => {
          const isSelected = selectedTransport === transport.id;
          return (
            <motion.button
              key={transport.id}
              onClick={() =>
                setSelectedTransport(isSelected ? null : transport.id)
              }
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              style={{
                padding: "14px 16px",
                borderRadius: 10,
                border: `1px solid ${isSelected ? transport.categoryColor : colors.cardBorder}`,
                background: isSelected
                  ? `${transport.categoryColor}10`
                  : colors.cardBg,
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.2s",
                position: "relative",
              }}
            >
              {/* Category dot */}
              <div
                style={{
                  position: "absolute",
                  top: 14,
                  right: 14,
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: transport.categoryColor,
                }}
              />

              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  fontFamily: "var(--font-mono)",
                  color: isSelected ? transport.categoryColor : colors.text,
                  marginBottom: 4,
                  paddingRight: 20,
                }}
              >
                {transport.name}
              </div>
              <div
                style={{
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  color: transport.categoryColor,
                  marginBottom: 8,
                }}
              >
                {transport.category}
              </div>
              <div style={{ fontSize: 11, color: colors.textSecondary, lineHeight: 1.5 }}>
                {transport.description}
              </div>
            </motion.button>
          );
        })}
      </div>

      {/* Selected transport detail */}
      <AnimatePresence>
        {selectedTransport && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: "hidden" }}
          >
            {(() => {
              const t = transports.find((tr) => tr.id === selectedTransport);
              if (!t) return null;
              return (
                <div
                  style={{
                    padding: "18px 22px",
                    borderRadius: 12,
                    border: `1px solid ${t.categoryColor}40`,
                    background: `${t.categoryColor}08`,
                  }}
                >
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 600,
                      color: colors.text,
                      marginBottom: 16,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {t.name}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                    <div>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: t.categoryColor,
                          fontFamily: "var(--font-mono)",
                          marginBottom: 6,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      >
                        How It Works
                      </div>
                      <div style={{ fontSize: 12, color: colors.textSecondary, lineHeight: 1.6 }}>
                        {t.howItWorks}
                      </div>
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: t.categoryColor,
                          fontFamily: "var(--font-mono)",
                          marginBottom: 6,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      >
                        When To Use
                      </div>
                      <div style={{ fontSize: 12, color: colors.textSecondary, lineHeight: 1.6 }}>
                        {t.whenToUse}
                      </div>
                    </div>
                  </div>

                  {/* Connection flow */}
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: t.categoryColor,
                      fontFamily: "var(--font-mono)",
                      marginBottom: 8,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    Connection Flow
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
                    {t.connectionFlow.map((step, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", flex: 1 }}>
                        <div
                          style={{
                            flex: 1,
                            textAlign: "center",
                            padding: "8px 6px",
                            borderRadius: 8,
                            background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)",
                            fontSize: 11,
                            fontFamily: "var(--font-mono)",
                            color: colors.text,
                          }}
                        >
                          {step}
                        </div>
                        {i < t.connectionFlow.length - 1 && (
                          <svg width="16" height="12" viewBox="0 0 16 12" fill="none" style={{ flexShrink: 0 }}>
                            <path d="M2 6H14M14 6L10 2M14 6L10 10" stroke={t.categoryColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Decision Tree ---

function DecisionTree({
  colors,
  isDark,
  currentNode,
  path,
  onAdvance,
  onReset,
  onBack,
}: {
  colors: Record<string, string>;
  isDark: boolean;
  currentNode: DecisionNode;
  path: string[];
  onAdvance: (id: string) => void;
  onReset: () => void;
  onBack: () => void;
}) {
  const isResult = !!currentNode.result;

  return (
    <div>
      {/* Path breadcrumb */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        {path.map((nodeId, i) => {
          const node = decisionTree.find((n) => n.id === nodeId);
          return (
            <div key={nodeId} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {i > 0 && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M4 2L8 6L4 10" stroke={colors.textSecondary} strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              )}
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: i === path.length - 1 ? colors.accent : colors.textSecondary,
                  fontWeight: i === path.length - 1 ? 600 : 400,
                }}
              >
                {node?.result ? "Result" : node?.question?.split("?")[0] || "Start"}
              </span>
            </div>
          );
        })}
      </div>

      {/* Current node */}
      <motion.div
        key={currentNode.id}
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.2 }}
        style={{
          padding: "24px 28px",
          borderRadius: 14,
          border: `1px solid ${isResult ? colors.green : colors.cardBorder}`,
          background: isResult ? colors.greenBg : colors.cardBg,
          marginBottom: 20,
        }}
      >
        {isResult ? (
          <div>
            <div
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                color: colors.green,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: 8,
              }}
            >
              Recommendation
            </div>
            <div style={{ fontSize: 15, color: colors.text, lineHeight: 1.6, marginBottom: 16 }}>
              {currentNode.result}
            </div>
            {currentNode.resultTransport && (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 14px",
                  borderRadius: 8,
                  background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  fontWeight: 600,
                  color: transports.find((t) => t.id === currentNode.resultTransport)?.categoryColor || colors.accent,
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: transports.find((t) => t.id === currentNode.resultTransport)?.categoryColor || colors.accent,
                  }}
                />
                {transports.find((t) => t.id === currentNode.resultTransport)?.name}
              </div>
            )}
          </div>
        ) : (
          <div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 600,
                color: colors.text,
                marginBottom: 20,
              }}
            >
              {currentNode.question}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {currentNode.options.map((opt) => (
                <motion.button
                  key={opt.next}
                  onClick={() => onAdvance(opt.next)}
                  whileHover={{ scale: 1.01, x: 4 }}
                  whileTap={{ scale: 0.99 }}
                  style={{
                    padding: "14px 18px",
                    borderRadius: 10,
                    border: `1px solid ${colors.cardBorder}`,
                    background: colors.surfaceBg,
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                    color: colors.text,
                    fontWeight: 500,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    transition: "border-color 0.2s",
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 4L10 8L6 12" stroke={colors.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {opt.label}
                </motion.button>
              ))}
            </div>
          </div>
        )}
      </motion.div>

      {/* Navigation */}
      <div style={{ display: "flex", gap: 8 }}>
        {path.length > 1 && (
          <button
            onClick={onBack}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: `1px solid ${colors.cardBorder}`,
              background: "transparent",
              color: colors.textSecondary,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
            }}
          >
            Back
          </button>
        )}
        {path.length > 1 && (
          <button
            onClick={onReset}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: `1px solid ${colors.cardBorder}`,
              background: "transparent",
              color: colors.textSecondary,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
            }}
          >
            Start Over
          </button>
        )}
      </div>
    </div>
  );
}

// --- OAuth Flow ---

function OAuthFlow({
  colors,
  isDark,
  activeStep,
  setActiveStep,
}: {
  colors: Record<string, string>;
  isDark: boolean;
  activeStep: number | null;
  setActiveStep: (step: number | null) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginBottom: 6 }}>
        RFC 9728 + RFC 8414 OAuth Discovery Chain
      </div>
      <div style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 20, lineHeight: 1.5 }}>
        When an MCP server returns 401, Claude Code walks through a multi-step discovery chain to find the authorization server.
        Click each step to see details.
      </div>

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

        {oauthSteps.map((step, i) => {
          const isActive = activeStep === step.id;
          return (
            <div key={step.id} style={{ position: "relative", marginBottom: i < oauthSteps.length - 1 ? 10 : 0 }}>
              {/* Dot */}
              <motion.div
                animate={{
                  background: isActive ? colors.accent : colors.textSecondary,
                  scale: isActive ? 1.3 : 1,
                }}
                style={{
                  position: "absolute",
                  left: -28 + 14 - 5,
                  top: 18,
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  zIndex: 1,
                  transition: "all 0.2s",
                }}
              />

              <motion.button
                onClick={() => setActiveStep(isActive ? null : step.id)}
                whileHover={{ scale: 1.01 }}
                style={{
                  width: "100%",
                  padding: "14px 18px",
                  borderRadius: 10,
                  border: `1px solid ${isActive ? colors.accent : colors.cardBorder}`,
                  background: isActive ? colors.accentBg : colors.cardBg,
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "all 0.2s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      fontFamily: "var(--font-mono)",
                      color: isActive ? colors.accent : colors.textSecondary,
                      minWidth: 24,
                    }}
                  >
                    {String(step.id).padStart(2, "0")}
                  </span>
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: isActive ? colors.accent : colors.text,
                      flex: 1,
                    }}
                  >
                    {step.title}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: colors.textSecondary,
                    marginTop: 4,
                    marginLeft: 34,
                  }}
                >
                  {step.description}
                </div>

                <AnimatePresence>
                  {isActive && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      style={{ overflow: "hidden" }}
                    >
                      <div
                        style={{
                          fontSize: 12,
                          color: colors.textSecondary,
                          marginTop: 10,
                          marginLeft: 34,
                          padding: "10px 14px",
                          borderRadius: 8,
                          background: colors.surfaceBg,
                          lineHeight: 1.6,
                        }}
                      >
                        {step.detail}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.button>
            </div>
          );
        })}
      </div>

      {/* Fallback chain */}
      <div
        style={{
          marginTop: 20,
          padding: "14px 18px",
          borderRadius: 12,
          border: `1px solid ${colors.cardBorder}`,
          background: colors.cardBg,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
          Fallback Chain
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap" }}>
          {[
            { label: "RFC 9728", desc: "Protected Resource" },
            { label: "RFC 8414", desc: "Auth Server Metadata" },
            { label: "Path-aware probing", desc: "Against MCP server URL" },
            { label: "authServerMetadataUrl", desc: "Escape hatch config" },
          ].map((step, i) => (
            <div key={step.label} style={{ display: "flex", alignItems: "center" }}>
              <div
                style={{
                  textAlign: "center",
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: colors.surfaceBg,
                  minWidth: 80,
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 600, fontFamily: "var(--font-mono)", color: colors.accent }}>
                  {step.label}
                </div>
                <div style={{ fontSize: 9, color: colors.textSecondary, marginTop: 2 }}>{step.desc}</div>
              </div>
              {i < 3 && (
                <div style={{ padding: "0 4px" }}>
                  <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
                    <path d="M2 6H14M14 6L10 2M14 6L10 10" stroke={colors.textSecondary} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: colors.textSecondary, marginTop: 10, lineHeight: 1.5 }}>
          The <code style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>authServerMetadataUrl</code> escape hatch exists because some OAuth servers implement neither RFC.
        </div>
      </div>
    </div>
  );
}
