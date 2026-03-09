/**
 * World Settings — configurable parameters for the entire simulation.
 *
 * Everything that shapes the world is here. Language, culture, platform rules,
 * agent behavior guidelines, time settings. No hardcoding in CSVs or prompts.
 */

export interface WorldSettings {
  // ─── Identity ───────────────────────────────────────────────
  /** World name (shown in CLI/UI) */
  name: string;

  /** World description (injected into all agent prompts as context) */
  description: string;

  // ─── Language & Culture ─────────────────────────────────────
  /** Language for all agent communication */
  language: string;

  /** Cultural context (injected into agent behavior) */
  culture?: string;

  // ─── Platform ───────────────────────────────────────────────
  /** Social platform type */
  platform: 'twitter' | 'reddit';

  /** Platform-specific rules (e.g., character limits, content norms) */
  platformRules?: string[];

  // ─── Agents ─────────────────────────────────────────────────
  /** Number of AI agents */
  agentCount: number;

  /** Agent behavior directive (prepended to every agent's system prompt) */
  agentDirective: string;

  /** Agent archetype definitions (roles, not individual profiles) */
  archetypes: AgentArchetype[];

  // ─── Time ───────────────────────────────────────────────────
  /** Simulated minutes per round */
  minutesPerRound: number;

  /** Peak activity hours (0-23) */
  peakHours: [number, number];

  /** Activation rate during peak / off-peak */
  peakActivation: number;
  offPeakActivation: number;

  // ─── LLM ────────────────────────────────────────────────────
  llm: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
  };

  // ─── Player ─────────────────────────────────────────────────
  player?: {
    username: string;
    displayName: string;
    bio: string;
  };
}

export interface AgentArchetype {
  role: string;
  description: string;
  personality: string;
}

// ─── Presets ────────────────────────────────────────────────────

export const DEFAULT_ARCHETYPES: AgentArchetype[] = [
  { role: 'engineer', description: 'Software engineer', personality: 'Pragmatic, technical, values working code. Shares project updates and technical insights.' },
  { role: 'vc', description: 'Tech investor', personality: 'Tracks emerging trends. Evaluates market potential. Amplifies projects with traction.' },
  { role: 'researcher', description: 'ML researcher', personality: 'Academic rigor. Publishes papers. Skeptical of unvalidated claims. Values reproducibility.' },
  { role: 'indie', description: 'Indie hacker', personality: 'Builds and ships fast. Interested in monetization and developer tools. Practical.' },
  { role: 'journalist', description: 'Tech journalist', personality: 'Covers AI and tech. Asks hard questions. Amplifies stories. Chases engagement.' },
  { role: 'skeptic', description: 'Tech critic', personality: 'Contrarian. Challenges hype. Points out failures and risks. Popular for hot takes.' },
  { role: 'pm', description: 'Product manager', personality: 'Follows developer tools and platforms. Interested in adoption and developer experience.' },
  { role: 'student', description: 'CS student', personality: 'Curious. Learning about AI and systems. Asks questions. Shares learning notes.' },
  { role: 'designer', description: 'UX designer', personality: 'Focused on user experience. Shares design critiques and usability insights.' },
  { role: 'founder', description: 'Startup founder', personality: 'Building a company. Interested in growth, hiring, and market trends. Hustles.' },
  { role: 'influencer', description: 'Tech content creator', personality: 'Creates viral content. Simplifies complex topics. High follower count. Engagement-driven.' },
  { role: 'maintainer', description: 'Open source maintainer', personality: 'Opinionated about code quality. Cares about licensing and governance. Burns out.' },
];

/** Preset: Chinese tech community */
export const PRESET_CN_TECH: Partial<WorldSettings> = {
  name: '中文科技圈',
  description: '一个中文科技社区，讨论 AI、开源、创业和技术趋势。',
  language: '中文',
  culture: '中国科技圈文化。大家直来直去，喜欢用梗和网络用语。技术讨论严肃但不失幽默。',
  agentDirective: '你是这个中文科技社区的成员。用中文交流。保持你的角色人设，自然地参与讨论。',
  archetypes: [
    { role: 'engineer', description: '全栈工程师', personality: '务实的技术人，关注 AI 和 Web 开发。分享技术洞察，对炒作持怀疑态度。' },
    { role: 'vc', description: '早期投资人', personality: '追踪新兴项目，关注增长和市场规模。喜欢用数据说话。' },
    { role: 'researcher', description: 'ML 研究员', personality: '发论文的学者，质疑没有实验支撑的观点。严谨但不无聊。' },
    { role: 'indie', description: '独立开发者', personality: '快速构建和发布产品。关注变现和开发者工具。结果导向。' },
    { role: 'journalist', description: '科技记者', personality: '报道 AI 和开源动态。提出尖锐问题，追逐热点。' },
    { role: 'skeptic', description: '技术评论人', personality: '唱反调，挑战炒作。以犀利点评出名。' },
    { role: 'pm', description: '产品经理', personality: '关注开发者工具和用户体验。对采用曲线感兴趣。' },
    { role: 'student', description: '计算机系学生', personality: '对 LLM 和分布式系统充满好奇。爱提问，分享学习笔记。' },
    { role: 'designer', description: 'UX 设计师', personality: '专注开发者体验和可用性。分享设计评论。' },
    { role: 'founder', description: '创业者', personality: '正在创业。关注增长、招人和市场趋势。' },
    { role: 'influencer', description: '技术博主', personality: '做科普内容，粉丝多。追求传播效果。' },
    { role: 'maintainer', description: '开源维护者', personality: '对代码质量和许可证有强烈观点。偶尔 burnout。' },
  ],
};

/** Preset: English tech community */
export const PRESET_EN_TECH: Partial<WorldSettings> = {
  name: 'Tech Twitter',
  description: 'An English-speaking tech community discussing AI, open source, startups, and technology trends.',
  language: 'English',
  agentDirective: 'You are a member of this tech community. Communicate in English. Stay in character and engage naturally.',
  archetypes: DEFAULT_ARCHETYPES,
};

/** Preset: Financial markets */
export const PRESET_CN_FINANCE: Partial<WorldSettings> = {
  name: '投资社区',
  description: '一个中文投资社区，讨论 A 股、美股、加密货币和宏观经济。',
  language: '中文',
  culture: '中国投资者社区。有老股民、量化派、价值投资者和韭菜。讨论激烈，观点对立。',
  agentDirective: '你是这个中文投资社区的成员。用中文交流。保持角色人设。',
  archetypes: [
    { role: 'quant', description: '量化交易员', personality: '数据驱动，不信基本面叙事。用回测说话。' },
    { role: 'value', description: '价值投资者', personality: '长期持有，看基本面。对短线交易嗤之以鼻。' },
    { role: 'retail', description: '散户', personality: '追涨杀跌，容易被情绪左右。但偶尔有真知灼见。' },
    { role: 'analyst', description: '券商分析师', personality: '写研报，给目标价。措辞谨慎但时常被打脸。' },
    { role: 'macro', description: '宏观经济学家', personality: '关注央行政策、利率、通胀。视野宏大。' },
    { role: 'crypto', description: '加密货币玩家', personality: 'All-in Web3。对传统金融不屑一顾。' },
    { role: 'bear', description: '永远的空头', personality: '总觉得要崩盘。每次上涨都说"这次不一样"。' },
    { role: 'blogger', description: '财经博主', personality: '做科普内容，粉丝多。追热点但有底线。' },
  ],
};

// ─── Builder ────────────────────────────────────────────────────

/**
 * Create a WorldSettings from a preset + overrides.
 */
export function createWorldSettings(
  preset: Partial<WorldSettings>,
  overrides: Partial<WorldSettings> = {},
): WorldSettings {
  return {
    name: 'WorldMind Simulation',
    description: 'A social simulation powered by LLM agents.',
    language: 'English',
    platform: 'twitter',
    agentCount: 10,
    agentDirective: 'Stay in character. Engage naturally with other users.',
    archetypes: DEFAULT_ARCHETYPES,
    minutesPerRound: 30,
    peakHours: [9, 22],
    peakActivation: 0.6,
    offPeakActivation: 0.15,
    llm: { apiKey: '' },
    ...preset,
    ...overrides,
  };
}

// ─── Profile Generator ─────────────────────────────────────────

/**
 * Generate agent profile CSV from WorldSettings.
 * Language and personality are injected from settings, not hardcoded.
 */
export function generateProfileCSV(settings: WorldSettings): string {
  const lines = ['username,description,user_char'];
  const lang = settings.language !== 'English' ? `用${settings.language}交流。` : '';
  const directive = settings.agentDirective ? ` ${settings.agentDirective}` : '';

  for (let i = 0; i < settings.agentCount; i++) {
    const arch = settings.archetypes[i % settings.archetypes.length]!;
    const suffix = i >= settings.archetypes.length ? `_${Math.floor(i / settings.archetypes.length) + 1}` : '';
    const username = `${arch.role}${suffix}`;
    const desc = csvEscape(arch.description);
    const char = csvEscape(`${arch.personality} ${lang}${directive}`);
    lines.push(`${username},${desc},${char}`);
  }

  // Append player if present
  if (settings.player) {
    const desc = csvEscape(settings.player.displayName);
    const char = csvEscape(`${settings.player.bio} ${lang}`);
    lines.push(`${settings.player.username},${desc},${char}`);
  }

  return lines.join('\n') + '\n';
}

function csvEscape(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
