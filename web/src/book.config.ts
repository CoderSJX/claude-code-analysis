export interface PartConfig {
  number: number;
  title: string;
  epigraph: string;
  chapters: number[];
}

export interface ChapterConfig {
  number: number;
  slug: string;
  title: string;
  description: string;
}

export const parts: PartConfig[] = [
  {
    number: 1,
    title: '基础',
    epigraph: '在智能体能够思考之前，进程必须先存在。',
    chapters: [1, 2, 3, 4],
  },
  {
    number: 2,
    title: '核心循环',
    epigraph: '智能体的心跳：流式输出、执行动作、观察结果、重复循环。',
    chapters: [5, 6, 7],
  },
  {
    number: 3,
    title: '多智能体编排',
    epigraph: '一个智能体已经很强，多个智能体协作则会带来质变。',
    chapters: [8, 9, 10],
  },
  {
    number: 4,
    title: '持久化与智能',
    epigraph: '没有记忆的智能体会永远重复同样的错误。',
    chapters: [11, 12],
  },
  {
    number: 5,
    title: '交互界面',
    epigraph: '用户看到的一切都要经过这一层。',
    chapters: [13, 14],
  },
  {
    number: 6,
    title: '连接能力',
    epigraph: '智能体的能力不局限于 localhost。',
    chapters: [15, 16],
  },
  {
    number: 7,
    title: '性能工程',
    epigraph: '把一切做得足够快，让人察觉不到背后的机器。',
    chapters: [17, 18],
  },
];

export const chapters: ChapterConfig[] = [
  { number: 1, slug: 'ch01-architecture', title: 'AI 智能体的架构', description: '6 个关键抽象、数据流、权限系统、构建系统' },
  { number: 2, slug: 'ch02-bootstrap', title: '快速启动 - Bootstrap 流程', description: '5 阶段初始化、模块级 I/O 并行、信任边界' },
  { number: 3, slug: 'ch03-state', title: '状态 - 双层架构', description: 'Bootstrap 单例、AppState 存储、粘性锁存器、成本追踪' },
  { number: 4, slug: 'ch04-api-layer', title: '与 Claude 对话 - API 层', description: '多提供商客户端、提示缓存、流式输出、错误恢复' },
  { number: 5, slug: 'ch05-agent-loop', title: '智能体循环', description: 'query.ts 深入解析、4 层压缩、错误恢复、Token 预算' },
  { number: 6, slug: 'ch06-tools', title: '工具 - 从定义到执行', description: '工具接口、14 步流水线、权限系统' },
  { number: 7, slug: 'ch07-concurrency', title: '并发工具执行', description: '分区算法、流式执行器、投机执行' },
  { number: 8, slug: 'ch08-sub-agents', title: '启动子智能体', description: 'AgentTool、15 步 runAgent 生命周期、内置智能体类型' },
  { number: 9, slug: 'ch09-fork-agents', title: 'Fork 智能体与提示缓存', description: '字节级一致前缀技巧、缓存共享、成本优化' },
  { number: 10, slug: 'ch10-coordination', title: '任务、协作与蜂群', description: '任务状态机、协调者模式、蜂群消息传递' },
  { number: 11, slug: 'ch11-memory', title: '记忆 - 跨会话学习', description: '基于文件的记忆、4 类分类、LLM 召回、陈旧性' },
  { number: 12, slug: 'ch12-extensibility', title: '可扩展性 - Skills 和 Hooks', description: '两阶段技能加载、生命周期 Hooks、快照安全' },
  { number: 13, slug: 'ch13-terminal-ui', title: '终端界面', description: '自定义 Ink 分支、渲染流水线、双缓冲、对象池' },
  { number: 14, slug: 'ch14-input-interaction', title: '输入与交互', description: '按键解析、快捷键绑定、组合键支持、vim 模式' },
  { number: 15, slug: 'ch15-mcp', title: 'MCP - 通用工具协议', description: '8 种传输方式、MCP OAuth、工具封装' },
  { number: 16, slug: 'ch16-remote', title: '远程控制与云端执行', description: 'Bridge v1/v2、CCR、上游代理' },
  { number: 17, slug: 'ch17-performance', title: '性能 - 每一毫秒和每一个 Token 都算数', description: '启动、上下文窗口、提示缓存、渲染、搜索' },
  { number: 18, slug: 'ch18-epilogue', title: '尾声 - 我们学到了什么', description: '5 个架构赌注、可迁移之处、智能体的未来方向' },
];

export function getPartForChapter(chapterNumber: number): PartConfig | undefined {
  return parts.find(p => p.chapters.includes(chapterNumber));
}

export function getChapterNumber(slug: string): number {
  const match = slug.match(/^ch(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

export function getAdjacentChapters(chapterNumber: number) {
  const idx = chapters.findIndex(c => c.number === chapterNumber);
  return {
    prev: idx > 0 ? chapters[idx - 1] : null,
    next: idx < chapters.length - 1 ? chapters[idx + 1] : null,
  };
}

export function isFirstChapterOfPart(chapterNumber: number): boolean {
  return parts.some(p => p.chapters[0] === chapterNumber);
}
