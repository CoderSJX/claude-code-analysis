# 第 9 章：Fork 代理与 Prompt Cache

## 百分之九十五的洞见

当父代理并行生成五个子代理时，绝大多数每个子代理的 API 请求都是一样的。系统提示一样，工具定义一样，对话历史一样，触发这些生成的 assistant 消息也一样。唯一不同的是最后那句指令：“你处理数据库迁移”“你写测试”“你更新文档”。

在一次典型的 fork 场景里，如果对话已经很热，共享前缀可能有 80,000 个 token。每个子代的指令可能只占 200 个 token。这意味着 99.75% 的重叠。Anthropic 的 prompt cache 会给缓存输入 token 90% 的折扣。如果你能让第 2 到第 5 个子代也命中这 80,000 个 token 的缓存，那四个请求的输入成本就会直接打九折。对父级来说，这相当于同样的并行派发，花费从 4 美元降到 50 美分。

难点在于 prompt 缓存是字节精确的。不是“差不多”。不是“语义等价”。从 system prompt 的第一个字节开始，到每个子代内容分叉前的最后一个字节为止，字节必须一模一样。多一个空格、工具定义顺序变了、某个过时的特性标志改动了 system prompt 的一小段，缓存就会 miss。整个前缀会按全价重新计算。

Fork 代理就是 Claude Code 对这个约束的回答。它们不只是“带着上下文生成一个子代”的便利功能，而是一个伪装成编排功能的 prompt cache 利用机制。fork 系统里的每一个设计决策，最后都回到同一个问题：怎样保证并行子代的前缀字节级一致？

---

## Fork 子代继承什么

Fork 代理从父级继承四样东西，而且都是通过引用或字节级复制继承，而不是重新计算。

**1. System prompt。** 不是重新生成，而是直接传递。父级已经渲染好的 system prompt 字节会通过 `override.systemPrompt` 传进来，来源是 `toolUseContext.renderedSystemPrompt`。这就是父级最近一次 API 调用里实际发送的字符串。

**2. 工具定义。** fork 代理定义声明 `tools: ['*']`，但只要 `useExactTools` 标志设为 true，子代就会直接拿到父级已经组装好的工具数组。没有过滤，没有重排，没有重新序列化。

**3. 对话历史。** 父级与 API 交换过的每一条消息 - 用户轮次、assistant 轮次、工具调用、工具结果 - 都会通过 `forkContextMessages` 克隆进子代上下文。

**4. thinking 配置和模型。** fork 定义里会指定 `model: 'inherit'`，解析后就是和父级完全一样的模型。相同模型意味着相同 tokenizer、相同上下文窗口、相同缓存命名空间。

fork 代理定义本身非常精简 - 几乎是一个 no-op：

fork 代理定义刻意保持最小化 - 它会继承父级的一切。它声明所有工具（`'*'`），继承父级模型，权限使用 bubble 模式（这样权限提示会出现在父级终端），并提供一个不会被真正调用的 no-op system prompt 函数 - 真正的 prompt 通过 override 通道传入，而且已经被渲染好，字节稳定。

---

## 字节一致前缀技巧

Claude 的 API 请求有固定结构：先是 system prompt，再是 tools，最后是 messages。要命中 prompt cache，从请求开头到某个前缀边界之间的每个字节都必须在各次请求里一致。

Fork 代理通过冻结三层来做到这一点：

**第 1 层：通过线程传递 system prompt，而不是重新计算。**

父代理上一次 API 调用里渲染出的 system prompt，会保存在 `toolUseContext.renderedSystemPrompt` 里。这个字符串包含了所有动态插值后的结果 - GrowthBook 特性标志、环境信息、MCP server 描述、skill 内容、`CLAUDE.md` 文件。fork 子代拿到的就是这个确切字符串。

为什么不直接再调一次 `getSystemPrompt()`？因为 system prompt 生成不是纯函数。SDK 拉取远端配置时，GrowthBook 标志会从 cold 变 warm。父级第一次轮次里是 `false` 的标志，在 fork 子代启动前可能已经变成 `true`。如果 system prompt 里有一个受该标志控制的条件块，重新渲染出来的提示哪怕只差一个字符，缓存就失效了。80,000 个 token 会按全价重算，而且是五个子代一起重算。

把已经渲染好的字节直接传下去，就能把这整类偏差全部消掉。

**第 2 层：通过精确透传工具定义。**

普通子智能体会走 `resolveAgentTools()`：它会根据代理定义里的 `tools` 和 `disallowedTools` 数组过滤工具池，应用权限模式差异，并可能重排工具。得到的序列化工具数组会和父级不同 - 子集不同、顺序不同、权限注解也不同。

fork 代理会完全跳过这一段：

```typescript
const resolvedTools = useExactTools
  ? availableTools  // parent's exact array
  : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools
```

`useExactTools` 只在 fork 路径上设为 true。子代拿到的是父级原样的工具池。同样的工具、同样的顺序、同样的序列化。这里甚至会把 Agent 工具本身保留在子代工具池里，尽管子代不允许使用它 - 因为删掉它会改变工具数组，进而让缓存失效。

**第 3 层：构造消息数组。**

这一步由 `buildForkedMessages()` 精心完成。它会构造出夹在共享历史和每个子代指令之间的最后两条消息：

`buildForkedMessages()` 会构造夹在共享历史和子代指令之间的最后两条消息。算法如下：

1. 克隆父级的 assistant 消息（保留所有 `tool_use` 块及其原始 ID）。
2. 对每个 `tool_use` 块，创建一个值固定的 `tool_result` 占位字符串（所有子代都一样）。
3. 构造一条 user 消息，把所有占位结果和包在 boilerplate 标签里的子代指令串在一起。
4. 返回 `[clonedAssistantMessage, userMessageWithPlaceholdersAndDirective]`。

```typescript
// Pseudocode — illustrates the message construction
function buildChildMessages(directive, parentAssistant) {
  const cloned = cloneMessage(parentAssistant)
  const placeholders = parentAssistant.toolUseBlocks.map(b =>
    toolResult(b.id, CONSTANT_PLACEHOLDER)  // Byte-identical across children
  )
  const userMsg = createUserMessage([...placeholders, wrapDirective(directive)])
  return [cloned, userMsg]
}
```

每个子代最终看到的消息数组长这样：

```
[...shared_history, assistant(all_tool_uses), user(placeholder_results..., directive)]
```

在指令之前的每一个元素，子代之间都是一致的。`FORK_PLACEHOLDER_RESULT` 这个常量字符串 `'Fork started -- processing in background'` 保证了连工具结果块都是字节一致的。`tool_use_id` 之所以一致，是因为它们都引用同一条 assistant 消息。只有最后那个文本块，也就是每个子代自己的指令，才会不同。

缓存边界正好落在那条最后文本块前面。它上方的一切 - 可能有几万 token 的 system prompt、工具定义、对话历史和占位结果 - 对第一个子代之后的每个子代都能按 90% 折扣命中缓存。

---

## Fork Boilerplate 标签

每个子代的指令都会被包进一个 boilerplate XML 标签里，这个标签有两个作用：一是告诉子代该怎么行为，二是作为递归 fork 检测的标记。

这个 boilerplate 大约包含 10 条规则。关键的是这些：

- **覆盖父级的 fork 指令。** 父级系统提示会说“默认在有并行工作时 fork” - boilerplate 会明确告诉子代：“那条指令是给父级的。你就是 fork。不要再生成子智能体。”
- **静默执行，只报告一次。** 工具调用之间不要输出对话文本。直接用工具，然后给出结构化总结。
- **保持在作用域内。** 子代不能把工作范围扩出去。
- **结构化输出格式。** 响应必须遵循 Scope / Result / Key files / Files changed / Issues 模板，这样多个子代同时回报时，父级更容易解析结果。

第 1 条尤其有意思。父级的系统提示 - fork 子代为了缓存原因原封不动继承了它 - 里面会有“在有并行工作时默认 fork”之类的指令。如果子代真的照做，就会继续 fork 自己的孩子，形成无限递归的代理。boilerplate 明确把它覆盖掉：“那条指令是给父级的。你就是 fork。”

结构化输出格式（Scope / Result / Key files / Files changed / Issues）不是装饰。它约束子代只能做事实汇报，这样当五个子代同时回报时，父级更容易解析并聚合结果。

---

## 递归 fork 防护

fork 子代会把 Agent 工具留在自己的工具池里。必须这样做 - 删掉它会改变序列化工具数组，让 prompt cache 失效。但如果子代真的调用了没有 `subagent_type` 的 Agent 工具，fork 路径就会再次触发，生成一个孙代 fork。这个孙代会继承更大的上下文（父 + 子的对话），再去 fork 自己的孩子，以此类推。

这里有两道防线：

**主防线：`querySource` 检查。** 当 fork 子代被生成时，它的 `context.options.querySource` 会被设为 `'agent:builtin:fork'`。`call()` 方法在允许 fork 路径之前会先检查它：

```typescript
// In AgentTool.call():
if (effectiveType === undefined) {
  // Fork path -- but are we already in a fork?
  if (querySource === 'agent:builtin:fork') {
    // Reject: already a fork child
  }
}
```

这是快路径。它只检查 options 对象里的一个字符串。

**兜底防线：消息扫描。** fork 防护用了两道 guard：生成时设置的 `querySource` 标记（快路径，只做一次字符串比较），以及一个扫描消息历史里 boilerplate XML 标签的兜底方案。这个 fallback 之所以存在，是因为 `querySource` 会随着 autocompact 一起保留下来，但在某些没有正确透传的边界情况里，消息扫描可以把递归兜住。这是一种“既要又要”的设计：检查成本（扫消息）与错误递归 fork 的代价（失控的 API 支出）相比，几乎可以忽略。

为什么还要兜底？因为 Claude Code 有 autocompact 功能，当上下文太长时会重写消息数组。autocompact 可以改消息内容，但会保留 options 里的 `querySource`。理论上，`querySource` 已经足够。实践里，消息扫描的 fallback 能抓住那些 `querySource` 没有正确传递的边缘情况 - 这依然是那种检查成本远小于误 fork 成本的“既要又要”。

---

## 从同步到异步的切换

fork 子代一开始是以前台方式运行的：它的消息会流到父级终端，父级会阻塞等待完成。但如果子代运行太久怎么办？Claude Code 允许在执行中途把前台任务切到后台 - 用户（或者自动超时）可以把一个正在运行的前台代理推入后台，而不会丢掉任何工作。

机制出乎意料地干净：

1. 当一个前台代理通过 `registerAgentForeground()` 注册时，会创建一个后台信号 promise。

2. 父级同步循环会在代理消息流和后台信号之间 race：

```
while (true) {
  const result = await Promise.race([
    iterator.next(),         // next message from agent
    backgroundSignal,        // "move to background" trigger
  ])
  if (result === BACKGROUND_SIGNAL) break
  // ... process message
}
```

3. 当后台信号触发时，前台 iterator 会通过 `iterator.return()` 优雅终止。这会触发 generator 的 `finally` 块，负责清理。

4. 一个新的 `runAgent()` 实例会以 `isAsync: true` 被生成，使用同一个 agent ID 和当前累积的消息历史。代理会从刚才离开的地方继续，现在以后台方式运行。

5. 原本同步的 `call()` 会返回 `{ status: 'async_launched' }`，父级继续它的对话。

没有任何工作会丢失，因为消息历史就是代理的状态。磁盘上的 sidechain transcript 记录了代理产出的每一条消息。新的异步实例会从这份 transcript 重放，然后接着同步实例停下的位置继续。

---

## 自动后台化

当 `CLAUDE_AUTO_BACKGROUND_TASKS` 环境变量或者 `tengu_auto_background_agents` GrowthBook 标志开启时，前台代理会在 120 秒后自动转为后台：

启用环境变量或特性标志后，前台代理会在 120 秒后自动后台化。关闭时，函数返回 0（不自动后台化）。

这是一个带成本影响的 UX 决策。前台代理会占住父级终端 - 用户不能输入，不能下新指令，也不能再生成别的代理。两分钟足够让代理把大多数快速任务同步做完（而流式输出也能提供有价值的反馈），但又不会让长任务一直绑架终端。

在 fork 实验里，这个自动后台化问题其实不再成立：所有 fork 生成从一开始就是强制异步。`run_in_background` 参数会从 schema 里直接消失。每个 fork 子代都会在后台运行，完成后通过 `<task-notification>` 回报，父级则不会被阻塞。

---

## 什么时候不会用 Fork

Fork 只是多种编排模式中的一种，而且在三种情况下会被刻意排除：

**Coordinator 模式。** Coordinator 模式和 fork 模式互斥。coordinator 有一套结构化委派模型：它维护计划、用明确提示把任务分配给 worker，并跟踪进度。fork 那种“继承一切”的做法会破坏这一点。一个被 fork 的 coordinator 会继承父级 coordinator 的系统提示（里面说“你是 coordinator，去分配工作”），子代就会试图编排，而不是执行。`isForkSubagentEnabled()` 会先检查 `isCoordinatorMode()`，如果正在运行就直接返回 false。

**非交互式会话。** SDK 和 API 消费者（`--print` 模式、Claude Agent SDK）没有终端。fork 的 `permissionMode: 'bubble'` 会把权限提示上浮到父级终端 - 但非交互式模式里根本没有这个终端。与其再造一套权限流，不如直接禁用 fork 路径。SDK 消费者改用显式的 `subagent_type` 选择。

**显式 `subagent_type`。** 当模型显式指定了 `subagent_type`（比如 `"Explore"`、`"Plan"`、`"general-purpose"`）时，fork 路径不会触发。fork 只会在省略 `subagent_type` 时触发。这样模型就能在“我想要一个有自己 system prompt 和工具集的专门代理”和“我想要一个继承我上下文、并行做这件事的克隆体”之间做选择。

---

## 经济学

看一个具体场景。开发者让 Claude Code 重构一个模块。父代理分析代码库，形成计划，然后并行派出五个 fork 子代：一个更新数据库 schema，一个重写服务层，一个更新路由，一个修测试，一个更新类型。

这时，对话里的共享上下文已经相当大了：
- System prompt：约 4,000 token
- 工具定义（40+ 个工具）：约 12,000 token
- 对话历史（分析 + 规划）：约 30,000 token
- 带有五个 `tool_use` 块的 assistant 消息：约 2,000 token
- 占位工具结果：约 500 token

共享前缀总计：约 48,500 token。每个子代的指令：约 200 token。

如果没有 fork（五个独立代理，各自有新上下文和自己的 system prompt）：
- 每个子代都要处理自己的 system prompt + 工具 + 任务 prompt
- 没有缓存共享（system prompt 不同，工具集不同）
- 成本：5 倍完整输入处理

如果使用 fork（字节一致前缀）：
- 子代 1：48,700 token 按全价计费（第一次请求缓存 miss）
- 子代 2-5：48,500 token 按 10% 价格计费（缓存 hit）+ 每个子代 200 token 按全价计费
- 子代 2-5 的有效成本：约 4,850 + 200 = 每个约 5,050 token 等值

节省会随着上下文大小和子代数量增长而扩大。对于一个有 100K token 历史、要并行生成 8 个 fork 的热会话，缓存节省可能超过原本输入 token 成本的 90%。

这就是 fork 系统里每个设计决策的原因 - 线程传递而不是重新计算、工具精确透传、占位结果、甚至把被禁止使用的 Agent 工具继续留在子代池里 - 它们都在优化同一件事：字节一致前缀。每个决策都拿一点优雅或安全去换可测量的 API 成本下降。

---

## 设计张力

fork 系统把一些值得理解的权衡显式化了：

**隔离 vs. 缓存效率。** fork 子代会继承一切，包括对它们任务可能无关的对话历史。一个在修测试的子代，并不需要父级讨论数据库 schema 设计时那 15 条消息。但保留这些消息，才是让前缀完全一致的办法。删掉无关历史能省上下文窗口空间，却会让缓存失效。这里的设计赌注是：缓存收益会大于上下文开销。

**安全 vs. 缓存效率。** Agent 工具会留在 fork 子代的工具池里，即使子代不能用它。把它删掉会更安全（子代甚至不会尝试 fork），但也会改变工具数组序列化。boilerplate 标签和递归 fork 防线就是补偿控制 - 用运行时阻止代替静态删除。

**简单 vs. 缓存效率。** 占位工具结果本质上是一种谎言。子代会在父级 assistant 消息的每个 `tool_use` 块后面看到 `'Fork started -- processing in background'`，无论那些工具调用实际做了什么。这没问题，因为子代的指令已经告诉它该做什么 - 它并不需要父级那次分派里的真实工具结果。但这也意味着子代的对话历史在技术上是不自洽的。这里选择占位值，是为了简短和一致，而不是准确。

这些权衡的优先级都一样：当你按 token 计费、而且规模很大时，字节一致的前缀值得你把架构扭成这个样子。

---

## 应用到这里：为 Prompt Cache 效率而设计

fork 代理模式可以推广到 Claude Code 之外。任何从同一上下文并发发出多个 LLM 调用的系统，都能从 cache-aware 的请求构造中受益。原则如下：

**1. 传递渲染后的 prompt，不要重新计算。** 如果你的 system prompt 里包含任何动态内容 - 特性标志、时间戳、用户偏好、A/B 测试变体 - 就把渲染结果保存下来，按值传给子代。重新计算会有偏差风险。

**2. 冻结工具数组。** 如果你的子代需要不同的工具集，那就意味着你放弃了工具块上的缓存共享。可以考虑保留完整工具集，用运行时 guard（像 fork boilerplate 里的“不要用 Agent”）来控制，而不是在编译期删工具。

**3. 把共享前缀做到最大，把每个子代的后缀做到最小。** 组织消息数组时，让所有共享内容都先出现，把每个子代专属内容放到最后。把共享内容和子代内容交错排列，会把缓存边界切碎。

**4. 用常量占位值表示可变内容。** 当消息结构要求对前面工具调用作出回应时，跨所有子代使用相同的占位字符串，而不是实际各不相同的结果。

**5. 计算盈亏平衡点。** 缓存共享是有成本的：每个子代的上下文窗口更大（会携带不相关历史），需要运行时 guard 而不是静态安全，以及额外的架构复杂度。要算清楚你的并行模式（多少个子代、共享前缀多大）在加上额外上下文 token 后，是否真的还省钱。

fork 代理系统本质上就是一个 prompt cache 利用引擎。它回答了每个多智能体系统构建者最终都会面对的问题：当缓存给你重复前缀 90% 折扣时，你会把架构重构到什么程度，去拿到这个折扣？Claude Code 的答案是：会重构到很深。
