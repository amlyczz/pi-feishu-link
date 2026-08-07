// One-click auth (spec §6.8 / R3): scan a QR code (or open the link) to
// create the Feishu/Lark app automatically via lark.registerApp; manual
// AppID/Secret entry as fallback.

import type { FeishuConfig, Domain, GroupPolicy } from "../common/types.js";
import { DEFAULT_CONFIG, saveConfig } from "../common/config.js";

export interface RegisterAppResult {
	appId: string;
	appSecret: string;
	domain: Domain;
}

export interface RegisterAppCallbacks {
	onQRCodeReady(url: string, expireInSec: number): void;
	onStatusChange?(info: { status?: string }): void;
}

export type RegisterAppFn = (
	callbacks: RegisterAppCallbacks,
) => Promise<{
	client_id?: string;
	client_secret?: string;
	user_info?: { tenant_brand?: string };
}>;

export interface SetupInput {
	mode: "auto" | "manual";
	registerApp?: RegisterAppFn;
	appId?: string;
	appSecret?: string;
	domain?: Domain;
	groupPolicy: GroupPolicy;
	/** UX 阶段回调（2026-08-07）：creating → callback → saved，供 TUI 展示进度 */
	onStage?: (stage: "creating" | "callback" | "saved") => void;
}

/** Run setup; returns the persisted config. */
export async function runSetup(input: SetupInput): Promise<FeishuConfig> {
	let appId = "";
	let appSecret = "";
	let domain: Domain = input.domain ?? "feishu";
	if (input.mode === "auto") {
		if (!input.registerApp) throw new Error("registerApp 未提供");
		input.onStage?.("creating");
		// The caller's registerApp implementation handles QR/link printing itself
		// (index.ts prints via qrcode-terminal inside its closure).
		const result = await input.registerApp({
			onQRCodeReady: () => {
				/* caller prints; nothing to do here */
			},
		});
		if (!result.client_id || !result.client_secret) {
			throw new Error("扫码创建应用失败：未拿到凭据");
		}
		appId = result.client_id;
		appSecret = result.client_secret;
		domain = result.user_info?.tenant_brand === "lark" ? "lark" : "feishu";
		input.onStage?.("callback");
	} else {
		appId = (input.appId ?? "").trim();
		appSecret = (input.appSecret ?? "").trim();
		if (!appId || !appSecret) throw new Error("需要 AppID 和 AppSecret");
	}
	const config: FeishuConfig = {
		...DEFAULT_CONFIG,
		appId,
		appSecret,
		domain,
		groupPolicy: input.groupPolicy,
	};
	saveConfig(config);
	input.onStage?.("saved");
	return config;
}
