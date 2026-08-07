/**
 * 机器人自定义菜单（Bot Customized Menu）支持。
 *
 * 飞书机器人菜单在开发者后台手工配置（无 OpenAPI），两种动作：
 * 1. 发送文字消息（V7.22+）：菜单文案作为普通消息发给机器人 →
 *    走既有命令管线（文案就是 "/cmd"），零新代码。
 * 2. 推送事件（所有版本）：订阅 application.bot.menu_v6 事件，
 *    event_key 作为唯一标识推给服务器 → 本模块映射为命令执行。
 *
 * 本模块只含纯函数（菜单定义 / key→命令映射 / 事件解析 / 配置引导文案），
 * 便于单测；事件接线在 transport.ts / index.ts。
 */

/** 机器人自定义菜单事件类型（SDK EventDispatcher 注册键）。 */
export const BOT_MENU_EVENT = "application.bot.menu_v6";

/** 菜单项：label 为后台配置文案，key 为事件推送标识（event_key）。 */
export interface BotMenuItem {
	label: string;
	/** event_key 必须是 ASCII 小写英文，与命令名一致便于映射 */
	key: string;
}

/**
 * 推荐菜单结构（悬浮菜单样式：≤5 主菜单 × ≤10 子菜单）。
 * setup 引导用户按此配置；key 与 /feishu 命令一一对应。
 */
export const BOT_MENU_RECOMMENDATION: readonly BotMenuItem[] = [
	{ label: "使用帮助", key: "help" },
	{ label: "查看状态", key: "status" },
	{ label: "开始新会话", key: "new" },
	{ label: "恢复会话", key: "resume" },
	{ label: "切换模型", key: "model" },
	{ label: "定时任务", key: "schedule" },
	{ label: "停止任务", key: "stop" },
] as const;

/** event_key → 命令文案。未知 key 返回 null（不响应，避免误触发）。 */
const MENU_KEY_TO_COMMAND: Readonly<Record<string, string>> = {
	help: "/help",
	status: "/status",
	new: "/new",
	resume: "/resume",
	model: "/model",
	schedule: "/schedule",
	stop: "/stop",
};

export function menuKeyToCommand(eventKey: string): string | null {
	return MENU_KEY_TO_COMMAND[eventKey] ?? null;
}

/** 归一化后的机器人菜单事件。 */
export interface BotMenuEvent {
	eventKey: string;
	operatorOpenId: string;
}

/**
 * 解析 SDK 事件数据 → 归一化菜单事件。
 * SDK 分发可能传原始（data.event 包裹）或拍平后的对象，两者都兼容。
 * 缺 event_key 或 operator 视为无效（菜单未配事件动作 / 未知用户）。
 */
export function parseBotMenuEvent(data: unknown): BotMenuEvent | null {
	if (!data || typeof data !== "object") return null;
	const d = data as Record<string, unknown>;
	const event = (d.event && typeof d.event === "object"
		? (d.event as Record<string, unknown>)
		: d) as Record<string, unknown>;
	const eventKey = typeof event.event_key === "string" ? event.event_key : "";
	const operator =
		event.operator && typeof event.operator === "object"
			? (event.operator as Record<string, unknown>)
			: undefined;
	const operatorId =
		operator?.operator_id && typeof operator.operator_id === "object"
			? (operator.operator_id as Record<string, unknown>)
			: undefined;
	const operatorOpenId =
		typeof operatorId?.open_id === "string" ? operatorId.open_id : "";
	if (!eventKey || !operatorOpenId) return null;
	return { eventKey, operatorOpenId };
}

/** 开发者后台配置菜单的固定路径（无 API，只能手工）。 */
export const MENU_CONSOLE_PATH =
	"开发者后台 → 添加应用能力 → 机器人 → 机器人自定义菜单 → 开启";

/**
 * setup 完成后展示的菜单配置引导文案。
 * 菜单仅支持单聊；"推送事件"动作需在事件配置中订阅
 * 「机器人自定义菜单事件」（本扩展已自动订阅，无需手动添加）。
 */
export function buildMenuGuideText(
	appId: string,
	domain: "feishu" | "lark",
): string {
	const consoleUrl =
		domain === "lark"
			? "https://open.larksuite.com/app"
			: "https://open.feishu.cn/app";
	return [
		"🤖 机器人菜单（输入框上方快捷入口）",
		`配置路径：${MENU_CONSOLE_PATH}`,
		`直达：${consoleUrl}/${appId}`,
		"",
		"1. 在「机器人自定义菜单」点【编辑】→ 状态切到【开启】",
		"2. 展示样式选【悬浮菜单】（V7.22+；≤5 主菜单 × ≤10 子菜单）",
		"3. 每个菜单项选动作【推送事件】，标识（event_key）填命令名：",
		...BOT_MENU_RECOMMENDATION.map(
			(item) => `   • ${item.label} → event_key: ${item.key}`,
		),
		"4. 也可选动作【发送文字消息】，文案直接填 /cmd（如 /status）",
		"5. 创建应用版本并发布，等 5 分钟生效（仅单聊展示）",
		"",
		"菜单事件订阅已由本扩展自动完成，点按即可触发对应命令。",
	].join("\n");
}
