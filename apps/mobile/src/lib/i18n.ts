/**
 * The phone's own strings.
 *
 * The desktop catalogs are shaped around desktop surfaces; the phone has a
 * different set of nouns (a pairing code, a Stop button, a bottom sheet). Keeping
 * them apart means neither side grows keys it never renders.
 */

export type Lang = "zh" | "en";

const en = {
  "app.name": "QianNing Agent",
  "connect.modeLocal": "On this phone",
  "connect.modeRemote": "On my computer",
  "local.title": "Run the agent here",
  "local.subtitle": "Any OpenAI-compatible endpoint. The key stays on this phone.",
  "local.baseUrl": "API base URL",
  "local.baseUrlHint": "https://api.deepseek.com/v1",
  "local.apiKey": "API key",
  "local.model": "Model",
  "local.modelHint": "deepseek-chat",
  "local.start": "Start",
  "local.busy": "Starting…",
  "local.needAll": "Fill in all three fields.",
  "connect.title": "Connect to your computer",
  "connect.subtitle": "Paste the pairing link from Settings → Remote access.",
  "connect.link": "Pairing link or address",
  "connect.linkHint": "https://192.168.1.5:4331",
  "connect.token": "Access token",
  "connect.tokenHint": "Shown once, when the device is issued",
  "connect.submit": "Connect",
  "connect.busy": "Connecting…",
  "connect.failed": "The Host refused the token.",
  "connect.unreachable": "No answer from that address.",
  "sessions.title": "Sessions",
  "sessions.new": "New session",
  "sessions.edit": "Edit",
  "sessions.done": "Done",
  "sessions.signOut": "Sign out",
  "sessions.empty": "No sessions yet.",
  "sessions.untitled": "Untitled session",
  "sessions.delete": "Delete",
  "sessions.deleteArmed": "Delete?",
  "sessions.project": "Project",
  "sessions.noProject": "No project",
  "sessions.noProjectHint": "The agent can chat but cannot touch files.",
  "sessions.cancel": "Cancel",
  "chat.back": "Sessions",
  "chat.placeholder": "Message the agent…",
  "chat.send": "Send",
  "chat.stop": "Stop",
  "chat.changes": "Changes",
  "chat.thinking": "Thinking",
  "chat.you": "You",
  "chat.agent": "Agent",
  "chat.live": "live",
  "chat.offline": "reconnecting…",
  "chat.empty": "Say something to start.",
  "chat.toolFailed": "failed",
  "approval.title": "Approval required",
  "approval.approve": "Allow",
  "approval.deny": "Deny",
  "approval.always": "Always allow",
  "diff.title": "Changes",
  "diff.empty": "No changes in this session's workspace.",
  "diff.close": "Close",
  "diff.noProject": "This session has no project folder, so there is no diff.",
  "error.generic": "Something went wrong.",
} as const;

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  "app.name": "QianNing Agent",
  "connect.modeLocal": "本机运行",
  "connect.modeRemote": "连接电脑",
  "local.title": "在这台手机上运行 agent",
  "local.subtitle": "任何兼容 OpenAI 的接口。密钥只存在这台手机上。",
  "local.baseUrl": "接口地址",
  "local.baseUrlHint": "https://api.deepseek.com/v1",
  "local.apiKey": "API Key",
  "local.model": "模型",
  "local.modelHint": "deepseek-chat",
  "local.start": "开始",
  "local.busy": "启动中…",
  "local.needAll": "三项都要填。",
  "connect.title": "连接你的电脑",
  "connect.subtitle": "从「设置 → 远程访问」复制配对链接。",
  "connect.link": "配对链接或地址",
  "connect.linkHint": "https://192.168.1.5:4331",
  "connect.token": "访问令牌",
  "connect.tokenHint": "签发设备时只显示一次",
  "connect.submit": "连接",
  "connect.busy": "连接中…",
  "connect.failed": "这个令牌被 Host 拒绝了。",
  "connect.unreachable": "这个地址没有响应。",
  "sessions.title": "会话",
  "sessions.new": "新建会话",
  "sessions.edit": "管理",
  "sessions.done": "完成",
  "sessions.signOut": "退出",
  "sessions.empty": "还没有会话。",
  "sessions.untitled": "未命名会话",
  "sessions.delete": "删除",
  "sessions.deleteArmed": "确认删除？",
  "sessions.project": "项目",
  "sessions.noProject": "不选项目",
  "sessions.noProjectHint": "只能聊天，agent 读不到也写不了文件。",
  "sessions.cancel": "取消",
  "chat.back": "会话",
  "chat.placeholder": "给 agent 发消息…",
  "chat.send": "发送",
  "chat.stop": "停止",
  "chat.changes": "改动",
  "chat.thinking": "思考",
  "chat.you": "你",
  "chat.agent": "Agent",
  "chat.live": "在线",
  "chat.offline": "正在重连…",
  "chat.empty": "说点什么开始。",
  "chat.toolFailed": "失败",
  "approval.title": "需要确认",
  "approval.approve": "允许",
  "approval.deny": "拒绝",
  "approval.always": "总是允许",
  "diff.title": "改动",
  "diff.empty": "这个会话的工作区没有改动。",
  "diff.close": "关闭",
  "diff.noProject": "这个会话没有项目文件夹，没有改动可看。",
  "error.generic": "出错了。",
};

const catalogs: Record<Lang, Record<MessageKey, string>> = { en, zh };

export function detectLang(): Lang {
  const raw = (typeof navigator === "undefined" ? "" : navigator.language || "").toLowerCase();
  return raw.startsWith("zh") ? "zh" : "en";
}

export type Translate = (key: MessageKey) => string;

export function createTranslator(lang: Lang = detectLang()): Translate {
  const catalog = catalogs[lang];
  return (key) => catalog[key] ?? en[key] ?? key;
}
