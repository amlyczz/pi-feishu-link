// Card builders (spec §9 懒人 UX): welcome card, command help card,
// approval card, status card. Pure functions producing Feishu card JSON.

export interface CardButton {
	text: string;
	value: Record<string, unknown>;
	buttonType?: "primary" | "danger" | "default";
}

export function buildWelcomeCard(botName: string): unknown {
	return {
		schema: "2.0",
		body: {
			elements: [
				{
					tag: "markdown",
					content: `## ✅ ${botName} 已连接\n\n你可以直接和我说话，或点下方按钮：`,
				},
				{
					tag: "action",
					actions: [
						button("📋 命令面板", { op: "help" }),
						button("🤖 切换模型", { op: "model" }),
						button("📊 状态", { op: "status" }),
					],
				},
			],
		},
	};
}

export function buildHelpCard(): unknown {
	return {
		schema: "2.0",
		body: {
			elements: [
				{
					tag: "markdown",
					content: "## 📋 命令面板\n点击按钮一键执行，或直接输入文字聊天：",
				},
				{
					tag: "action",
					actions: [
						button("🆕 新会话", { op: "new" }),
						button("📚 历史会话", { op: "resume" }),
						button("🤖 切换模型", { op: "model" }),
						button("💭 思考等级", { op: "thinking" }),
						button("🛑 停止", { op: "stop" }),
						button("📁 工作区", { op: "workspace" }),
						button("📊 状态", { op: "status" }),
						button("🧹 压缩上下文", { op: "compact" }),
						button("🩺 导出诊断", { op: "support" }),
						button("⚙️ 配置", { op: "feishu-config" }),
					],
				},
				{
					tag: "markdown",
					content:
						'文本命令：`/new` `/resume` `/model` `/stop` `/workspace /路径` `/status` `/help` `/support`\n\n定时任务：直接说"每天 9 点提醒我喝水"即可创建。',
				},
			],
		},
	};
}

export function buildApprovalCard(
	approvalId: string,
	toolName: string,
	paramsText: string,
	dangerous = false,
): unknown {
	const banner = dangerous
		? "⚠️ **危险命令**——该命令匹配破坏性黑名单（如 `rm -rf /`、`curl … | sh`），确认后再批准。\n\n"
		: "";
	return {
		schema: "2.0",
		body: {
			elements: [
				{
					tag: "markdown",
					content: `## 🔐 工具审批\n\n${banner}**${toolName}** 请求执行：\n\n\`\`\`\n${paramsText.slice(0, 500)}\n\`\`\`\n\n${dangerous ? "批准后本次会话不再询问（可配置关闭）——仅管理员可审批。" : "仅管理员可审批；批准后本次会话不再询问（可配置关闭）。"}`,
				},
				{
					tag: "action",
					actions: [
						button("✅ 批准", { op: "approve", approvalId }, "primary"),
						button("❌ 拒绝", { op: "deny", approvalId }, "danger"),
					],
				},
			],
		},
	};
}

export function buildStatusCard(
	statusText: string,
	detailLines: string[],
): unknown {
	return {
		schema: "2.0",
		body: {
			elements: [
				{ tag: "markdown", content: `## 📊 状态\n${statusText}` },
				...detailLines.map((line) => ({ tag: "markdown", content: line })),
				{
					tag: "action",
					actions: [button("🩺 导出诊断", { op: "support" })],
				},
			],
		},
	};
}

export function buildSimpleTextCard(text: string): unknown {
	return {
		schema: "2.0",
		body: { elements: [{ tag: "markdown", content: text }] },
	};
}

function button(
	text: string,
	value: Record<string, unknown>,
	buttonType: CardButton["buttonType"] = "default",
): unknown {
	const b: Record<string, unknown> = {
		tag: "button",
		text: { tag: "plain_text", content: text },
		value,
	};
	if (buttonType && buttonType !== "default") b.button_type = buttonType;
	return b;
}
