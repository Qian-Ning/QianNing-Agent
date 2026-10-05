<script setup lang="ts">
import { computed } from 'vue'
import { withBase } from 'vitepress'

/**
 * Every internal path goes through `withBase`. The site is published under a
 * repository sub-path, and VitePress only rewrites the base into markdown
 * links and `themeConfig.logo` -- a literal string in a component template is
 * emitted exactly as written, so `/guide/install` shipped as
 * `https://<host>/guide/install` and 404'd. `withBase` is the documented way to
 * keep component-owned paths in step with `base`.
 */
const u = (path: string) => withBase(path)

const props = defineProps<{ locale: string }>()
const isZh = computed(() => props.locale === 'zh-CN')

const version = '0.16.3'
const releaseHref = 'https://github.com/Qian-Ning/QianNing-Agent/releases/latest'
const repoHref = 'https://github.com/Qian-Ning/QianNing-Agent'

const brandMark = u('/app-icon.png')
const shot = computed(() => u(`/readme/hero.${isZh.value ? 'zh' : 'en'}.webp`))

const copy = computed(() =>
  isZh.value
    ? {
        kicker: 'QianNing Agent · 千凝',
        title: '把长期任务交给一个真正的桌面工作台。',
        lead: '千凝把会话、项目、模型、工具、审查和子智能体放在同一个本地优先的工作空间。你可以看见它在做什么，也可以随时停下来检查。',
        primary: '5 分钟开始',
        primaryHref: u('/zh-CN/guide/'),
        secondary: `下载 v${version}`,
        releaseHref,
        imageAlt: '千凝桌面工作台，显示项目、对话与工具执行过程',
        facts: [
          ['本地优先', '会话、项目索引和设置保存在本机；模型请求直达你配置的服务。'],
          ['过程可见', '工具调用、权限确认、执行输出和文件改动都回到同一条会话时间线。'],
          ['模型可替换', '连接云端、本地或 OpenAI 兼容接口，不把工作流锁在单一模型上。'],
        ],
        startTitle: '从一个可验证的任务开始',
        startLead: '第一次使用不需要读完整套规格。按下面的顺序走一遍，就能建立一个可恢复、可审查的项目会话。',
        steps: [
          ['01', '安装与升级', '选择与你的系统匹配的安装包，了解自动更新和便携版的区别。', u('/zh-CN/guide/install')],
          ['02', '连接模型', '添加服务、选择模型，再用测试连接确认接口和密钥可用。', u('/zh-CN/guide/first-session#连接一个模型')],
          ['03', '打开项目', '将会话绑定到项目目录，文件工具会以这个目录作为默认边界。', u('/zh-CN/guide/first-session#创建第一个项目会话')],
          ['04', '交付并检查', '让 Agent 完成一个小任务，检查工具记录、变更内容和测试结果。', u('/zh-CN/guide/first-session#完成第一个可验证任务')],
        ],
        workflowTitle: '不是聊天窗口，是持续工作的现场',
        workflows: [
          ['Agent', '直接执行', '适合目标清楚的日常任务。Agent 会查看项目、修改文件并运行验证，权限策略仍由宿主执行。'],
          ['Plan', '先看方案', '适合重构和高风险变更。方案会保存为不可变检查点，批准后才进入执行。'],
          ['Goal', '先锁定结果', '先确认目标、验收标准和边界，批准后由 Agent 自主决定实现路径。'],
          ['Subagents', '并行拆分', '内置子智能体可以处理独立搜索、测试、修复或审查，父任务继续推进并收集结果。'],
        ],
        boundaryTitle: '本地优先，边界写清楚',
        boundaryBody: '正式版数据默认位于 ~/.qianning-agent。Renderer 没有 Node 权限；Rust host-core 独占 SQLite、工具执行和权限判断。密钥通过 Electron safeStorage 加密后由 host-core 管理，但当前尚未接入操作系统钥匙串；能以同一系统用户读取数据目录的进程，仍在本地威胁模型内。',
        boundaryLink: '阅读数据与安全说明',
        boundaryHref: u('/zh-CN/guide/data-and-security'),
        architectureTitle: '按职责拆开的运行时',
        architectureLead: '界面、桌面编排、权限与持久化、模型循环分别属于不同进程。跨边界只走受控 IPC 或本地 RPC。',
        layers: [
          ['Renderer', 'React 界面与交互；无直接 Node、文件系统或 SQLite 权限。'],
          ['Electron Main', '窗口、IPC、进程监管、更新和受控桌面能力。'],
          ['Rust Host Core', '持久化、工作区边界、工具执行、权限和审计。'],
          ['Agent Runtime', '模型连接、上下文、工具编排、子智能体与流式响应。'],
        ],
        exploreTitle: '按你的任务继续读',
        explore: [
          ['使用指南', '安装、第一次会话、自动化、MCP 与界面说明。', u('/zh-CN/guide/')],
          ['产品规格', '产品范围、运行时协议、存储、安全和交付契约。', u('/zh-CN/spec/README')],
          ['插件开发', '从 manifest 到设置页、工具、面板、服务与打包。', u('/zh-CN/plugin-development')],
          ['架构决策', '查看重要取舍、边界为什么存在，以及后续如何演进。', u('/zh-CN/adr/')],
        ],
        ctaTitle: '现在就把工作台搭起来',
        ctaLead: '下载安装包，按五分钟路径建立第一个项目会话；也可以先读规格，确认它是否适合你的工作方式。',
        ctaActions: [
          [`下载 v${version}`, releaseHref],
          ['阅读使用指南', u('/zh-CN/guide/')],
          ['在 GitHub 上查看', repoHref],
        ],
      }
    : {
        kicker: 'QianNing Agent · 千凝',
        title: 'A desktop workspace for work that lasts longer than one prompt.',
        lead: 'QianNing Agent keeps projects, sessions, models, tools, review, and subagents in one local-first workspace. You can see what it is doing and stop to inspect at any point.',
        primary: 'Start in 5 minutes',
        primaryHref: u('/guide/'),
        secondary: `Download v${version}`,
        releaseHref,
        imageAlt: 'QianNing Agent desktop workspace showing projects, a conversation, and tool execution',
        facts: [
          ['Local-first', 'Sessions, project indexes, and settings live on your machine; model requests go to the provider you configure.'],
          ['Visible work', 'Tool calls, approvals, output, and file changes return to the same session timeline.'],
          ['Replaceable models', 'Connect cloud, local, or OpenAI-compatible endpoints without rebuilding the workflow.'],
        ],
        startTitle: 'Start with one verifiable task',
        startLead: 'You do not need the complete specification on day one. Follow this path once to establish a recoverable, reviewable project session.',
        steps: [
          ['01', 'Install and update', 'Pick the package for your platform and understand automatic versus manual update lanes.', u('/guide/install')],
          ['02', 'Connect a model', 'Add a provider, select a model, and test the endpoint before starting work.', u('/guide/first-session#connect-a-model')],
          ['03', 'Open a project', 'Bind the session to a project directory. File tools use it as their default boundary.', u('/guide/first-session#create-your-first-project-session')],
          ['04', 'Deliver and inspect', 'Ask for one small change, then inspect the tool record, diff, and verification result.', u('/guide/first-session#complete-a-verifiable-task')],
        ],
        workflowTitle: 'A working surface, not a chat box',
        workflows: [
          ['Agent', 'Execute directly', 'For clear everyday work. The Agent can inspect, edit, and validate while host-owned permission policy stays in force.'],
          ['Plan', 'Review the route first', 'For refactors and high-risk changes. The plan is stored as an immutable checkpoint before execution approval.'],
          ['Goal', 'Lock the outcome first', 'Agree on the outcome, acceptance criteria, and boundaries; the Agent chooses the implementation after approval.'],
          ['Subagents', 'Split independent work', 'Built-in subagents can search, test, fix, or review while the parent task continues and later collects their reports.'],
        ],
        boundaryTitle: 'Local-first, with the boundary stated plainly',
        boundaryBody: 'Packaged data lives in ~/.qianning-agent by default. The renderer has no Node privileges; Rust host-core exclusively owns SQLite, tool execution, and permission decisions. Secrets are encrypted through Electron safeStorage and managed by host-core, but an OS keychain backend is not implemented today. A same-user process that can read the data directory remains inside the local threat model.',
        boundaryLink: 'Read data and security notes',
        boundaryHref: u('/guide/data-and-security'),
        architectureTitle: 'A runtime split by responsibility',
        architectureLead: 'Presentation, desktop orchestration, privileged persistence, and the model loop live in separate processes. Controlled IPC or local RPC is the only path across them.',
        layers: [
          ['Renderer', 'React presentation and interaction, with no direct Node, filesystem, or SQLite access.'],
          ['Electron Main', 'Window lifecycle, IPC routing, process supervision, updates, and reviewed desktop capabilities.'],
          ['Rust Host Core', 'Persistence, workspace boundaries, tool execution, permissions, and audit.'],
          ['Agent Runtime', 'Providers, context, tool orchestration, subagents, and streaming responses.'],
        ],
        exploreTitle: 'Continue by the job you need to do',
        explore: [
          ['User guide', 'Installation, first session, automations, MCP, and interface orientation.', u('/guide/')],
          ['Product specification', 'Scope, runtime protocols, storage, security, and delivery contracts.', u('/spec/README')],
          ['Plugin development', 'From manifest to settings, tools, panels, services, and packaging.', u('/plugin-development')],
          ['Architecture decisions', 'Read the trade-offs, why boundaries exist, and how they may evolve.', u('/adr/README')],
        ],
        ctaTitle: 'Set the workbench up now',
        ctaLead: 'Download a package and follow the five-minute path to a first project session, or read the specification first and decide whether it fits how you work.',
        ctaActions: [
          [`Download v${version}`, releaseHref],
          ['Read the user guide', u('/guide/')],
          ['View on GitHub', repoHref],
        ],
      },
)
</script>

<template>
  <main class="qn-home">
    <section class="qn-hero">
      <div class="qn-hero__copy">
        <p class="qn-kicker">
          <img class="qn-mark" :src="brandMark" alt="" aria-hidden="true" width="22" height="22" />
          {{ copy.kicker }}
        </p>
        <h1>{{ copy.title }}</h1>
        <p class="qn-hero__lead">{{ copy.lead }}</p>
        <div class="qn-actions">
          <a class="qn-button qn-button--primary" :href="copy.primaryHref">{{ copy.primary }}</a>
          <a class="qn-button qn-button--secondary" :href="copy.releaseHref">{{ copy.secondary }}</a>
        </div>
      </div>
      <figure class="qn-product-shot">
        <img :src="shot" :alt="copy.imageAlt" width="1600" height="1067" fetchpriority="high" />
      </figure>
      <dl class="qn-facts">
        <div v-for="fact in copy.facts" :key="fact[0]">
          <dt>{{ fact[0] }}</dt>
          <dd>{{ fact[1] }}</dd>
        </div>
      </dl>
    </section>

    <section class="qn-section qn-start">
      <header class="qn-section__header">
        <h2>{{ copy.startTitle }}</h2>
        <p>{{ copy.startLead }}</p>
      </header>
      <ol class="qn-steps">
        <li v-for="step in copy.steps" :key="step[0]">
          <a :href="step[3]">
            <span class="qn-step__number">{{ step[0] }}</span>
            <strong>{{ step[1] }}</strong>
            <span>{{ step[2] }}</span>
            <span class="qn-arrow" aria-hidden="true">→</span>
          </a>
        </li>
      </ol>
    </section>

    <section class="qn-section qn-workflow">
      <header class="qn-section__header qn-section__header--compact">
        <h2>{{ copy.workflowTitle }}</h2>
      </header>
      <div class="qn-workflow__list">
        <article v-for="workflow in copy.workflows" :key="workflow[0]">
          <code>{{ workflow[0] }}</code>
          <div>
            <h3>{{ workflow[1] }}</h3>
            <p>{{ workflow[2] }}</p>
          </div>
        </article>
      </div>
    </section>

    <section class="qn-section qn-boundary">
      <div>
        <p class="qn-kicker">LOCAL DATA</p>
        <h2>{{ copy.boundaryTitle }}</h2>
      </div>
      <div>
        <p>{{ copy.boundaryBody }}</p>
        <a :href="copy.boundaryHref">{{ copy.boundaryLink }} <span aria-hidden="true">→</span></a>
      </div>
    </section>

    <section class="qn-section qn-architecture">
      <header class="qn-section__header">
        <h2>{{ copy.architectureTitle }}</h2>
        <p>{{ copy.architectureLead }}</p>
      </header>
      <div class="qn-layers" role="list">
        <div v-for="(layer, index) in copy.layers" :key="layer[0]" role="listitem">
          <span>{{ String(index + 1).padStart(2, '0') }}</span>
          <strong>{{ layer[0] }}</strong>
          <p>{{ layer[1] }}</p>
        </div>
      </div>
    </section>

    <section class="qn-section qn-explore">
      <header class="qn-section__header qn-section__header--compact">
        <h2>{{ copy.exploreTitle }}</h2>
      </header>
      <nav class="qn-link-list" :aria-label="copy.exploreTitle">
        <a v-for="item in copy.explore" :key="item[0]" :href="item[2]">
          <strong>{{ item[0] }}</strong>
          <span>{{ item[1] }}</span>
          <span class="qn-arrow" aria-hidden="true">→</span>
        </a>
      </nav>
    </section>

    <section class="qn-section qn-cta">
      <div class="qn-cta__copy">
        <img class="qn-mark qn-mark--lg" :src="brandMark" alt="" aria-hidden="true" width="44" height="44" />
        <h2>{{ copy.ctaTitle }}</h2>
        <p>{{ copy.ctaLead }}</p>
      </div>
      <div class="qn-cta__actions">
        <a
          v-for="(action, index) in copy.ctaActions"
          :key="action[0]"
          class="qn-button"
          :class="index === 0 ? 'qn-button--primary' : 'qn-button--secondary'"
          :href="action[1]"
        >
          {{ action[0] }}
        </a>
      </div>
    </section>
  </main>
</template>
