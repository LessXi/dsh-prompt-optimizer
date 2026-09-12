window.__ModuleLoader__.load({
	id: "@lessxi/dsh-prompt-optimizer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const API = "/prompt-optimizer/api";
		const NS = "dsh-prompt-optimizer";
		/** 客户端侧目录缓存有效期（宿主侧另有 30s 缓存，这里避免频繁打网络）。 */
		const CATALOG_TTL_MS = 60 * 1000;
		/* 单例闸门：插件包会被 HMR 重新求值，旧实例的监听若尚未回收就会"替新实例干活"——
		   结果是旧实例拦截了发送、跑起了优化，但它的 UI 早已卸载 ⇒ 后台在跑、弹窗不显示。
		   这里让每个实例在 apply 时抢注 token，只有持有 token 的实例才有权拦截与渲染。 */
		const INSTANCE_TOKEN = NS + "#" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
		const isActiveInstance = () => {
			try { return window.__DPO_ACTIVE__ === INSTANCE_TOKEN; } catch (e) { return true; }
		};
		const MARK = "data-dpo";

		/* ══════════ 模块状态（P0 骨架：只服务于"手势拦截实测"） ══════════ */
		const store = {
			armed: true,
			tier: "basic",
			permission: "review",
			modelLabel: "会话默认",
			modelSel: null,
			modelCatalog: null,
			modelCatalogAt: 0,
			modelCatalogLoading: false,
			modelCatalogError: null,
			modelCatalogPromise: null,
			modelPop: null,
			modelPopOpen: false,
			node: null,
			overlay: { open: false, text: "", src: "" },
			reviewText: null,
			regenAsk: false,
			regenDir: "",
			touched: false,
			intercepts: [],
			listeners: new Set(),
			latest: { input: null, session: null, actions: null, sessionId: undefined },
			viewSessionId: null,
			stash: {},
			tierBySession: {},
			permissionBySession: {},
			helpOpen: false,
			helpPos: null,
			tierPop: null,
			tierPopOpen: false,
			permPop: null,
			permPopOpen: false,
		};

		/** 四个下拉弹层互斥：只保留 one 展开（one 为 null 时全部收起）。 */
		function closePops(one) {
			store.tierPopOpen = one === "tier";
			store.permPopOpen = one === "perm";
			store.modelPopOpen = one === "model";
			store.helpOpen = one === "help";
		}

		/** 弹层条目的键盘导航：↑/↓ 在条目间移动焦点，Home/End 跳首尾。
		 *  Enter/Space 由 button 原生触发点击，无需额外处理；stopPropagation 避免外层快捷键（如 ↑↓ 翻历史）抢走。 */
		function popItemKeyNav(e) {
			const k = e.key;
			if (k !== "ArrowDown" && k !== "ArrowUp" && k !== "Home" && k !== "End") return;
			const wrap = e.currentTarget && e.currentTarget.closest ? e.currentTarget.closest(".dpo-pop") : null;
			if (!wrap) return;
			const items = [...wrap.querySelectorAll(".dpo-pop-item")];
			const i = items.indexOf(e.currentTarget);
			if (i < 0 || items.length === 0) return;
			e.preventDefault();
			e.stopPropagation();
			const next = k === "ArrowDown" ? (i + 1) % items.length
				: k === "ArrowUp" ? (i - 1 + items.length) % items.length
					: k === "Home" ? 0 : items.length - 1;
			if (items[next] && items[next].focus) items[next].focus();
		}
		const TIERS = [
			{ id: "off", label: "关闭", hint: "原样发出，不拦截", help: "完全不拦截，恢复原生发送" },
			{ id: "basic", label: "普通", hint: "快速润色，约 3 秒", help: "只把话说清楚，不加新需求（约 3 秒）" },
			{ id: "advanced", label: "高级", hint: "优化更完整，约 20 秒", help: "补上显然需要的约束与验收（约 20 秒）" },
			{ id: "extreme", label: "极端", hint: "反复查证，约 20 秒以上", help: "读项目真实结构 → 分阶段行动计划 + 预案（约 20 秒）" },
		];
		const PERMISSIONS = [
			{ id: "review", label: "审查", hint: "停在浮窗，等你确认再发出", help: "产出可编辑，点「确认提交」才发送" },
			{ id: "auto", label: "自动", hint: "优化完直接替你把消息发出", help: "优化一完成就自动发出（失败也会按原文发出）" },
		];
		let noticeTimer = 0;
		function showNotice(text) {
			store.notice = { text, until: Date.now() + 2600 };
			emit();
			if (noticeTimer) window.clearTimeout(noticeTimer);
			noticeTimer = window.setTimeout(() => { store.notice = null; noticeTimer = 0; emit(); }, 2700);
		}
		function persistState(patch) {
			try {
				fetch(API + "/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ tier: store.tier, permission: store.permission, model: store.modelSel, sessionId: store.viewSessionId || null }, patch || {})) }).catch(() => {});
			} catch (e) { /* best effort */ }
		}
		/** 浮层几何（尺寸/位置）落盘：尺寸可自定义并跨会话记住。探针期间被抑制。 */
		function persistUi() {
			try {
				if (store.suppressUiPersist === true) return;
				const size = store.overlaySize || {};
				const pos = store.overlayPos || {};
				fetch(API + "/state", {
					method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ ui: { w: size.w || null, h: size.h || null, x: pos.x === undefined ? null : Math.round(pos.x), y: pos.y === undefined ? null : Math.round(pos.y) } }),
				}).catch(() => {});
			} catch (e) { /* best effort */ }
		}
		function setTier(id, why) {
			store.tier = id;
			store.armed = id !== "off";
			if (why !== "init") store.tierBySession[sessionKey()] = id; // 只改本会话
			if (why !== "init") store.touched = true;
			beacon("tier-change", { tier: id, armed: store.armed, why: why || "ui" });
			if (why !== "init") persistState();
			emit();
		}
		function setPermission(id, why) {
			if (store.tier === "off") return;
			store.permission = id;
			if (why !== "init") store.permissionBySession[sessionKey()] = id;
			if (why !== "init") store.touched = true;
			beacon("permission-change", { permission: id, why: why || "ui" });
			if (why !== "init") persistState();
			emit();
		}
		/* ══════════ 档位/权限：按会话独立（v55） ══════════
		   每个会话各记一份；没设过的会话继承"上次用的值"（即全局默认）。
		   切换会话时像弹窗一样换入换出 —— 在 A 改档位不会影响 B。 */
		function sessionKey() { return store.viewSessionId || "__none__"; }
		function rememberTierPermission() {
			const k = sessionKey();
			store.tierBySession[k] = store.tier;
			store.permissionBySession[k] = store.permission;
		}
		function applyTierPermissionFor(sid) {
			const k = sid || "__none__";
			const t = store.tierBySession[k];
			const p = store.permissionBySession[k];
			if (typeof t === "string") { store.tier = t; store.armed = t !== "off"; }
			if (typeof p === "string") store.permission = p;
		}

		/* ══════════ 会话隔离：弹窗属于触发它的那个会话 ══════════
		   迷你窗/运行/审查编辑都挂在"当前查看的会话"上；切换会话时把这一份暂存起来，
		   切回来再取回 —— 于是 A 里触发的弹窗不会跑到 B，切回 A 又原样出现。 */
		const VIEW_KEYS = ["run", "overlay", "reviewText", "regenAsk", "regenDir", "rollbackConfirm"];
		function emptyView() {
			return {
				run: null,
				overlay: { open: false, text: "", fullText: "", src: "", sessionId: null, blocked: false },
				reviewText: null, regenAsk: false, regenDir: "", rollbackConfirm: false,
			};
		}
		function stashCurrentView() {
			const sid = store.viewSessionId || "__none__";
			const snap = {};
			for (const k of VIEW_KEYS) snap[k] = store[k];
			store.stash[sid] = snap;
		}
		function restoreViewFor(sid) {
			const key = sid || "__none__";
			const snap = store.stash[key];
			if (snap) { for (const k of VIEW_KEYS) store[k] = snap[k]; return true; }
			const blank = emptyView();
			for (const k of VIEW_KEYS) store[k] = blank[k];
			return false;
		}
		/** composer 报告"当前会话"变化时调用（slot 的 sessionId 是权威来源）。 */
		function onViewSessionChange(next) {
			const sid = next || null;
			if (sid === store.viewSessionId) return;
			const prev = store.viewSessionId;
			rememberTierPermission();      // 把旧会话的档位/权限存进它自己
			stashCurrentView();
			store.viewSessionId = sid;
			applyTierPermissionFor(sid);   // 载入新会话的（没设过则继承当前默认）
			const restored = restoreViewFor(sid);
			beacon("view-session-change", {
				from: prev, to: sid, restored,
				carried: restored && store.run ? store.run.status : null,
				tier: store.tier, permission: store.permission, tierScope: Object.keys(store.tierBySession).length,
				pendingSessions: Object.keys(store.stash).filter((k) => {
					const s = store.stash[k];
					return s && ((s.run && s.run.status !== "aborted") || (s.overlay && s.overlay.open));
				}).length,
			});
			// 切回时若该会话的优化已完成且是自动档，这时才补发（只有当前会话有 composer 可提交）
			const run = store.run;
			if (restored && run && run.readyToSend && store.permission === "auto") {
				const text = String(run.readyToSend);
				run.readyToSend = null;
				window.setTimeout(() => {
					try {
						if (store.latest.actions && store.latest.sessionId === sid) {
							store.latest.actions.setDraft(text);
							store.latest.actions.submit();
							store.overlay.open = false;
							store.run = null;
							store.reviewText = null;
							showNotice("已按 " + ((TIERS.find((x) => x.id === run.tier) || {}).label || run.tier) + " 档优化结果发送");
							emit();
						}
					} catch (e) { /* noop */ }
				}, 320);
			}
			emit();
		}

		function emit() { for (const fn of [...store.listeners]) { try { fn() } catch (e) { /* noop */ } } }
		function setOverlay(patch) { store.overlay = Object.assign({}, store.overlay, patch); emit(); }
		function record(kind, text, extra) {
			const row = Object.assign({ t: Date.now(), kind, text: String(text || "").slice(0, 160) }, extra || {});
			store.intercepts.push(row);
			emit();
			return row;
		}
		function draftFromHook() {
			const s = store.latest.input;
			return s && typeof s.draft === "string" ? s.draft : "";
		}
		/* 拦截判定必须读"此刻编辑器里真实存在的字"：React 快照可能滞后于用户输入 */
		function draftFromDom() {
			const ed = editorOf(cardOf(store.node));
			if (!ed) return null;
			const raw = typeof ed.innerText === "string" && ed.innerText.length > 0 ? ed.innerText : (ed.textContent || "");
			return raw.replace(/\u00a0/g, " ");
		}
		function draftLive() {
			const dom = draftFromDom();
			return dom === null ? draftFromHook() : dom;
		}
		function sessionOf() { return store.latest.session || {}; }
		function runningNow() { return sessionOf().running === true; }

		/* ══════════ DOM 定位（全部从本插件节点结构推导，不用产品类名/选择器） ══════════ */
		function cardOf(node) {
			let el = node;
			while (el && el !== document.body) {
				if (el.querySelector && el.querySelector('[contenteditable="true"]')) return el;
				el = el.parentElement;
			}
			return null;
		}
		function editorOf(card) { return card ? card.querySelector('[contenteditable="true"]') : null; }
		function buttonsOf(card) { return card ? Array.from(card.querySelectorAll("button")) : []; }
		function lastButtonOf(card) { const list = buttonsOf(card); return list.length ? list[list.length - 1] : null; }
		/* 发送按钮定位：①本地化标签命中（首选）②兜底=卡片内最后一个 button（官方主按钮的结构位置） */
		function sendButtonOf(card) {
			if (!card) return null;
			for (const b of buttonsOf(card)) {
				const label = b.getAttribute("aria-label");
				if (label && SEND_LABELS.has(label)) return b;
			}
			return lastButtonOf(card);
		}
		function isSendLabel(label) { return Boolean(label && SEND_LABELS.has(label)); }

		/* 发送按钮本地化标签集：懒解析 + locale 变化时重取（产品字典晚于本插件注册时不再失配） */
		const SEND_LABELS = new Set();
		const STOP_LABELS = new Set();
		let localeService = null;
		function loadSendLabels() {
			SEND_LABELS.clear();
			STOP_LABELS.clear();
			try {
				const t = localeService ? localeService.bind("conversation") : null;
				if (t) {
					for (const key of ["input.send", "input.send.queue", "input.send.steer"]) {
						const v = t(key);
						if (typeof v === "string" && v && v !== key) SEND_LABELS.add(v);
					}
					const stop = t("input.stop");
					if (typeof stop === "string" && stop && stop !== "input.stop") STOP_LABELS.add(stop);
				}
			} catch (e) { /* 字典不可用 → 点击路径走结构兜底 */ }
			return [...SEND_LABELS];
		}
		function ensureLabels() { if (SEND_LABELS.size === 0) loadSendLabels(); return SEND_LABELS.size > 0; }

		/* 焦点追踪仅作遥测；判定一律以"此刻 activeElement 是否在输入卡片内"为准 */
		let lastFocusInComposer = false;
		let lastKeyBeacon = 0;
		function insideComposer() {
			const card = cardOf(store.node);
			if (!card) return false;
			const active = document.activeElement;
			if (!active || !card.contains(active)) return false;      // 设置页/重命名框/空白处：一律放行
			if (active.closest && active.closest("button")) return false; // 焦点在按钮上（模型座位等）：Enter 交还官方
			if (active.closest && active.closest('[data-dpo="overlay"]')) return false; // 浮层内的输入（重跑方向等）：Enter 交还浮层
			return true;
		}

		function beacon(stage, data) {			try {
				fetch(API + "/beacon", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(Object.assign({ t: Date.now(), stage }, data || {})),
				}).catch(() => {});
			} catch (e) { /* best effort */ }
		}

		/* ══════════ 拦截判定（唯一真源，探针与真实手势共用） ══════════ */
		function interceptKey(e) {
			if (!store.armed) return false;
			if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
			if (e.isComposing === true || e.keyCode === 229) return false;
			if (!cardOf(store.node)) return false;
			if (!insideComposer()) return false;
			const trimmed = draftLive().trim();
			if (!trimmed || trimmed.startsWith("/")) return false;
			return true;
		}
		/** 点击接管的唯一判定（探针可直接对任意按钮求值，无需真的派发事件）。 */
		function wouldInterceptClick(btn) {
			if (!store.armed || !btn) return false;
			// 浮层自身的按钮永不吞（回退/×/确认提交/重新生成…）
			if (btn.closest && btn.closest('[data-dpo="overlay"]')) return false;
			const card = cardOf(store.node);
			if (!card || !card.contains(btn)) return false;
			// 只有"要发出去的草稿"才接管：空草稿时主按钮是"停止生成"，绝不可吞
			if (!draftLive().trim()) return false;
			const label = btn.getAttribute("aria-label");
			if (label && STOP_LABELS.has(label)) return false;
			ensureLabels();
			return isSendLabel(label) || lastButtonOf(card) === btn;
		}
		function interceptClick(e) {
			const target = e.target;
			const btn = target && target.closest ? target.closest("button") : null;
			return wouldInterceptClick(btn);
		}

		/* ══════════ 两个入口组件 ══════════ */
		/* 滑块（可拖动 + 每档可点命中区）：档位 4 档 / 权限 2 档 */
		function Slider(props) {
			const trackRef = React.useRef(null);
			const draggingRef = React.useRef(false);
			const prevRef = React.useRef(props.value);
			const [tick, setTick] = React.useState(0);
			React.useEffect(() => {
				if (prevRef.current !== props.value) { prevRef.current = props.value; setTick((n) => n + 1); }
			}, [props.value]);
			const idx = Math.max(0, props.options.findIndex((o) => o.id === props.value));
			const last = Math.max(1, props.options.length - 1);
			const pct = (idx / last) * 100;
			const pickFromX = (clientX) => {
				if (props.disabled === true) return;
				const el = trackRef.current;
				if (!el) return;
				const r = el.getBoundingClientRect();
				const t = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
				const opt = props.options[Math.round(t * last)];
				if (opt && opt.id !== props.value) props.onPick(opt.id);
			};
			const onDown = (e) => {
				if (props.disabled === true) return;
				draggingRef.current = true;
				try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* 合成指针无捕获 */ }
				pickFromX(e.clientX);
				e.preventDefault();
			};
			const onMove = (e) => { if (draggingRef.current) pickFromX(e.clientX); };
			const onUp = (e) => {
				if (!draggingRef.current) return;
				draggingRef.current = false;
				try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
			};
			return h("div", {
				className: "dpo-slider",
				"data-dpo": props.name,
				"data-disabled": String(props.disabled === true),
				title: (props.title || "") + "（可拖动；当前：" + ((props.options[idx] || {}).label || "") + "）",
			},
				h("div", {
					ref: trackRef, className: "dpo-slider-track", "data-dpo": props.name + "-track",
					onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp,
				},
					h("div", { className: "dpo-slider-fill", style: { width: pct + "%" } }),
					h("div", { className: "dpo-slider-thumb", style: { left: pct + "%" } }),
					...props.options.map((opt) => h("button", {
						key: opt.id,
						type: "button",
						className: "dpo-stop",
						"data-dpo": props.name + "-" + opt.id,
						"data-on": String(props.value === opt.id),
						disabled: props.disabled === true,
						title: opt.label,
						onClick: () => { if (props.disabled === true) return; props.onPick(opt.id); },
					})),
				),
				h("span", { className: "dpo-slider-value", "data-dpo": props.name + "-value", key: "v" + tick }, (props.options[idx] || {}).label || ""),
			);
		}

		/** 模型目录：真加载 + 缓存 + 状态（曾经只在探针里拉过一次，弹层永远停在"加载中"）。 */
		function loadCatalog(reason, force) {
			const now = Date.now();
			if (!force && store.modelCatalog && store.modelCatalogAt && (now - store.modelCatalogAt) < CATALOG_TTL_MS) return Promise.resolve(store.modelCatalog);
			if (store.modelCatalogLoading === true) return store.modelCatalogPromise || Promise.resolve(store.modelCatalog);
			store.modelCatalogLoading = true;
			store.modelCatalogError = null;
			emit();
			const t0 = Date.now();
			const url = API + "/models" + (force ? "?force=1" : "");
			store.modelCatalogPromise = fetch(url, { cache: "no-store" })
				.then((r) => r.json())
				.then((d) => {
					const groups = d && Array.isArray(d.groups) ? d.groups : [];
					store.modelCatalog = { current: (d && d.current) || null, groups };
					store.modelCatalogAt = Date.now();
					store.modelCatalogLoading = false;
					store.modelCatalogError = groups.length === 0 ? "目录为空" : null;
					beacon("catalog-loaded", {
						reason: reason || "ui", groups: groups.length,
						models: groups.reduce((n, g) => n + ((g.models || []).length), 0),
						ms: Date.now() - t0, cached: d && d.cached === true, hostBuiltMs: d && d.builtMs,
						degraded: d && d.degraded ? d.degraded : null,
					});
					emit();
					return store.modelCatalog;
				})
				.catch((e) => {
					store.modelCatalogLoading = false;
					store.modelCatalogError = String(e && e.message ? e.message : e);
					beacon("catalog-error", { reason: reason || "ui", error: store.modelCatalogError.slice(0, 200), ms: Date.now() - t0 });
					emit();
					return null;
				});
			return store.modelCatalogPromise;
		}

		/** 使用帮助（放在模型胶囊右侧）：简洁操作教程 + 推荐组合。 */
		function helpPopover() {
			if (store.helpOpen !== true) return null;
			const pos = store.helpPos || { x: 40, bottom: 200, maxH: 420 };
			const line = (k, v, id) => h("div", { className: "dpo-help-row", key: id }, h("span", { className: "dpo-help-k" }, k), h("span", { className: "dpo-help-v" }, v));
			return h("div", {
				className: "dpo-pop dpo-help-pop", "data-dpo": "help-pop", role: "dialog", "aria-label": "使用帮助",
				style: { left: pos.x + "px", bottom: (pos.bottom || 200) + "px", maxHeight: (pos.maxH || 420) + "px" },
			},
				h("div", { className: "dpo-pop-head" }, "使用帮助 · 提示词优化"),
				h("div", { className: "dpo-help-sec" }, "怎么用"),
				line("①", "照常输入，按 Enter（或点发送）"),
				line("②", "消息不会直接发出，先被优化"),
				line("③", "迷你窗里看「思考/产出」，再决定发送"),
				h("div", { className: "dpo-help-sec" }, "档位"),
				...TIERS.map((t) => line(t.label, t.help, t.id)),
				h("div", { className: "dpo-help-sec" }, "发送"),
				...PERMISSIONS.map((p) => line(p.label, p.help, p.id)),
				h("div", { className: "dpo-help-sec" }, "迷你窗按钮"),
				line("‹ 回退", "停止优化、关闭窗口、不发消息、原文留在输入框"),
				line("重新生成", "先给个方向，再按该方向重跑一版"),
				line("放行本条", "不优化了，按你的原文直接发出"),
				line("右下角", "拖拽可改窗口大小（会记住）"),
				h("div", { className: "dpo-help-tip", "data-dpo": "help-tip" },
					"想要发挥插件所有能力且自动化，建议【极端】+【自动】。",
				),
				h("div", { className: "dpo-pop-foot" },
					h("button", { type: "button", className: "dpo-btn", "data-dpo": "help-close", onClick: () => { store.helpOpen = false; emit(); } }, "知道了"),
				),
				// 署名（面板最底部）
				h("div", { className: "dpo-help-meta", "data-dpo": "help-meta" },
					"作者：啃轮胎的西狐 · v0.1.1-beta.1 · 2026/09/11"),
			);
		}

		/** v72 · 档位下拉：4 个离散档位用横向滑块是"连续量"隐喻，DSH 对同类选择一律用下拉。 */
		function tierPopover() {
			if (!store.tierPopOpen) return null;
			const pos = store.tierPop || { x: 40, bottom: 200, maxH: 320 };
			return h("div", {
				className: "dpo-pop", "data-dpo": "tier-pop", role: "menu", "aria-label": "提示词优化档位",
				style: { left: pos.x + "px", bottom: pos.bottom + "px", maxHeight: pos.maxH + "px" },
			},
				h("div", { className: "dpo-pop-head" }, "提示词优化档位"),
				h("div", { className: "dpo-pop-group" },
					TIERS.map((t) => h("button", {
						key: t.id, type: "button", className: "dpo-pop-item", "data-dpo": "tier-item", role: "menuitemradio", "aria-checked": String(store.tier === t.id),
						"data-tier": t.id, "data-selected": String(store.tier === t.id),
						onClick: () => { setTier(t.id); store.tierPopOpen = false; emit(); },
						onKeyDown: popItemKeyNav,
					}, t.label, h("span", { className: "dpo-pop-chip-quiet" }, t.hint || ""))),
				),
				h("div", { className: "dpo-pop-foot" },
					h("button", { type: "button", className: "dpo-btn", "data-dpo": "tier-close", onClick: () => { store.tierPopOpen = false; emit(); } }, "关闭"),
				),
			);
		}
		/** v72 · 发送方式下拉：2 个互斥选项，横向滑块最不合理。 */
		function permPopover() {
			if (!store.permPopOpen) return null;
			const pos = store.permPop || { x: 40, bottom: 200, maxH: 320 };
			return h("div", {
				className: "dpo-pop", "data-dpo": "perm-pop", role: "menu", "aria-label": "优化完成后",
				style: { left: pos.x + "px", bottom: pos.bottom + "px", maxHeight: pos.maxH + "px" },
			},
				h("div", { className: "dpo-pop-head" }, "优化完成后"),
				h("div", { className: "dpo-pop-group" },
					PERMISSIONS.map((p) => h("button", {
						key: p.id, type: "button", className: "dpo-pop-item", "data-dpo": "perm-item", role: "menuitemradio", "aria-checked": String(store.permission === p.id),
						"data-perm": p.id, "data-selected": String(store.permission === p.id),
						onClick: () => { setPermission(p.id); store.permPopOpen = false; emit(); },
						onKeyDown: popItemKeyNav,
					}, p.label, h("span", { className: "dpo-pop-chip-quiet" }, p.hint || ""))),
				),
				h("div", { className: "dpo-pop-foot" },
					h("button", { type: "button", className: "dpo-btn", "data-dpo": "perm-close", onClick: () => { store.permPopOpen = false; emit(); } }, "关闭"),
				),
			);
		}

		function modelPopover() {
			if (!store.modelPopOpen) return null;
			const cat = store.modelCatalog;
			const pos = store.modelPop || { x: 40, bottom: 200, maxH: 320 };
			const groups = cat && Array.isArray(cat.groups) ? cat.groups : [];
			if (groups.length === 0 && store.modelCatalogLoading !== true) loadCatalog("popover-open", false);
			return h("div", {
				className: "dpo-pop", "data-dpo": "model-pop", role: "menu", "aria-label": "优化模型",
				style: { left: pos.x + "px", bottom: (pos.bottom || 200) + "px", maxHeight: (pos.maxH || 320) + "px" },
				onMouseLeave: () => { /* 保持打开，点击外部关闭 */ },
			},
				h("div", { className: "dpo-pop-head" }, "优化模型（与对话模型独立）"),
				store.modelCatalogLoading === true && groups.length === 0
					? h("div", { className: "dpo-pop-empty", "data-dpo": "model-loading" }, "正在加载模型目录…")
					: null,
				groups.length === 0 && store.modelCatalogLoading !== true
					? h("div", { className: "dpo-pop-empty", "data-dpo": "model-error" },
						(store.modelCatalogError ? "加载失败：" + store.modelCatalogError : "（暂无可用模型）"),
						h("button", { type: "button", className: "dpo-btn", "data-dpo": "model-retry", onClick: () => loadCatalog("retry", true) }, "重试"),
					)
					: null,
				...groups.map((g) => h("div", { key: g.id, className: "dpo-pop-group", "data-dpo": "model-group" },
					h("div", { className: "dpo-pop-gtitle", "data-dpo": "model-group-name" }, g.name + "（" + (g.models || []).length + "）" + (g.degraded ? " · 不可达" : "")),
					...(g.models || []).map((m) => {
						const sel = store.modelSel && store.modelSel.provider === g.id && store.modelSel.model === m.id;
						const cur = cat && cat.current && cat.current.provider === g.id && cat.current.model === m.id;
						return h("button", {
							key: g.id + "/" + m.id, type: "button", className: "dpo-pop-item", "data-dpo": "model-item", role: "menuitemradio", "aria-checked": String(Boolean(sel)),
							"data-provider": g.id, "data-model": m.id,
							"data-selected": String(Boolean(sel)), "data-session": String(Boolean(cur) && !sel),
							title: g.name + " · " + m.name + (cur ? "（当前会话模型）" : ""),
							onClick: () => { store.modelSel = { provider: g.id, model: m.id, name: m.name }; store.modelPopOpen = false; persistState(); emit(); },
							onKeyDown: popItemKeyNav,
						}, m.name, cur && !sel ? h("span", { className: "dpo-pop-chip" }, "会话当前") : null);
					}),
				)),
				h("div", { className: "dpo-pop-foot" },
					h("button", { type: "button", className: "dpo-btn", "data-dpo": "model-reset", onClick: () => { store.modelSel = null; store.modelPopOpen = false; persistState({ tier: store.tier, permission: store.permission, model: null }); emit(); } }, "恢复默认（跟随会话）"),
					h("button", { type: "button", className: "dpo-btn", "data-dpo": "model-refresh", onClick: () => loadCatalog("refresh", true) }, "刷新目录"),
					h("button", { type: "button", className: "dpo-btn", "data-dpo": "model-close", onClick: () => { store.modelPopOpen = false; emit(); } }, "关闭"),
				),
			);
		}

		function Controls(props) {
			const nodeRef = React.useRef(null);
			const input = props.useInput((s) => s);
			const session = props.useSession((s) => s);
			store.latest.input = input;
			store.latest.session = session;
			store.latest.actions = props.inputActions;
			store.latest.sessionId = props.sessionId;
			React.useEffect(() => {
				store.node = nodeRef.current;
				return () => { if (store.node === nodeRef.current) store.node = null; };
			}, []);
			// 会话切换：迷你窗/运行属于触发它的会话（切走收起、切回恢复）
			React.useEffect(() => { onViewSessionChange(props.sessionId || null); }, [props.sessionId]);
			const [, force] = React.useState(0);
			React.useEffect(() => {
				const fn = () => force((x) => x + 1);
				store.listeners.add(fn);
				return () => { store.listeners.delete(fn); };
			}, []);
			React.useEffect(() => {
				const mq = window.matchMedia("(max-width: 1240px)");
				const onMq = () => { store.narrow = mq.matches; force((x) => x + 1); };
				onMq();
				try { mq.addEventListener("change", onMq); return () => mq.removeEventListener("change", onMq); } catch (e) { return () => {}; }
			}, []);
			// 下拉弹层：点击外部或按 Esc 收起（与 DSH 原生菜单一致）
			React.useEffect(() => {
				if (!store.tierPopOpen && !store.permPopOpen && !store.modelPopOpen && !store.helpOpen) return undefined;
				const close = () => { closePops(null); emit(); };
				// 键盘可及：弹层打开后把初始焦点交给当前选中项（与 DSH 原生菜单一致）
				try {
					const pop = document.querySelector(".dpo-pop");
					if (pop) {
						const items = pop.querySelectorAll(".dpo-pop-item");
						const cur = pop.querySelector('.dpo-pop-item[data-selected="true"]') || items[0];
						if (cur && cur.focus) cur.focus({ preventScroll: true });
					}
				} catch (e) { /* noop */ }
				const onDown = (e) => {
					const t = e.target;
					if (t && t.closest && (t.closest(".dpo-pop") || t.closest('[data-dpo="tier"],[data-dpo="perm"],[data-dpo="model"],[data-dpo="help"]'))) return;
					close();
				};
				const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
				window.addEventListener("pointerdown", onDown, true);
				window.addEventListener("keydown", onKey, true);
				return () => {
					window.removeEventListener("pointerdown", onDown, true);
					window.removeEventListener("keydown", onKey, true);
				};
			}, [store.tierPopOpen, store.permPopOpen, store.modelPopOpen, store.helpOpen]);
			const n = store.intercepts.length;
			const off = store.tier === "off";
			if (!isActiveInstance()) return null; // 旧实例不再渲染控件（新实例已接管）
			return h("div", { ref: nodeRef, className: "dpo-controls", "data-dpo": "controls" },
								h("button", {
						type: "button", className: "dpo-model", "data-dpo": "tier",
						"data-open": String(store.tierPopOpen === true), "aria-haspopup": "menu", "aria-expanded": String(store.tierPopOpen === true),
						title: "提示词优化档位：" + TIERS.map((x) => x.label).join(" / "),
						onClick: (e) => { const r = e.currentTarget.getBoundingClientRect(); store.tierPop = { x: Math.max(8, Math.min(r.left, window.innerWidth - 376)), bottom: Math.max(8, window.innerHeight - r.top + 6), maxH: Math.max(140, r.top - 16) }; const willOpen = !store.tierPopOpen; closePops(willOpen ? "tier" : null); emit(); },
					},
						h("span", { className: "dpo-model-k" }, "档位"),
						h("span", { className: "dpo-model-v" }, (TIERS.find((x) => x.id === store.tier) || {}).label || ""),
						h("span", { className: "dpo-model-caret" }, "▾"),
					),
				h("button", {
					type: "button", className: "dpo-model", "data-dpo": "perm",
					"data-open": String(store.permPopOpen === true), "aria-haspopup": "menu", "aria-expanded": String(store.permPopOpen === true),
					"data-off": String(off),
					title: off ? "档位为「关闭」时不生效" : "优化完成后：先给你过目 / 直接发出",
					onClick: (e) => { if (off) return; const r = e.currentTarget.getBoundingClientRect(); store.permPop = { x: Math.max(8, Math.min(r.left, window.innerWidth - 376)), bottom: Math.max(8, window.innerHeight - r.top + 6), maxH: Math.max(140, r.top - 16) }; const willOpen = !store.permPopOpen; closePops(willOpen ? "perm" : null); emit(); },
				},
					h("span", { className: "dpo-model-k" }, "发送"),
					h("span", { className: "dpo-model-v" }, (PERMISSIONS.find((x) => x.id === store.permission) || {}).label || ""),
					h("span", { className: "dpo-model-caret" }, "▾"),
				),
				h("button", {
					type: "button",
					className: "dpo-model",
					"data-dpo": "model",
					"data-open": String(store.modelPopOpen === true), "aria-haspopup": "menu", "aria-expanded": String(store.modelPopOpen === true),
					"data-default": String(!store.modelSel),
					title: "优化所用模型（与对话模型独立）",
					onClick: (e) => { const r = e.currentTarget.getBoundingClientRect(); store.modelPop = { x: Math.max(8, Math.min(r.left, window.innerWidth - 376)), bottom: Math.max(8, window.innerHeight - r.top + 6), maxH: Math.max(140, r.top - 16) }; const willOpen = !store.modelPopOpen; closePops(willOpen ? "model" : null); emit(); },
				},
					h("span", { className: "dpo-model-v" }, store.modelSel ? store.modelSel.name : store.modelLabel),
					h("span", { className: "dpo-model-caret" }, "▾"),
				),
				h("button", {
					type: "button", className: "dpo-help", "data-dpo": "help",
					"data-open": String(store.helpOpen === true), "aria-haspopup": "dialog", "aria-expanded": String(store.helpOpen === true),
					title: "使用帮助（怎么用 / 档位 / 发送 / 迷你窗按钮）",
					onClick: (e) => {
						const r = e.currentTarget.getBoundingClientRect();
						store.helpPos = { x: Math.max(8, Math.min(r.left - 260, window.innerWidth - 404)), bottom: Math.max(8, window.innerHeight - r.top + 6), maxH: Math.max(200, r.top - 16) };
						const willOpen = !store.helpOpen;
						closePops(willOpen ? "help" : null);
						emit();
					},
				}, "?"),
				helpPopover(),
				store.notice && Date.now() < store.notice.until
					? h("span", { className: "dpo-notice", "data-dpo": "notice" }, store.notice.text)
					: null,
				tierPopover(),
				permPopover(),
				modelPopover(),
				n > 0 ? h("span", { className: "dpo-count", "data-dpo": "count", title: "本次会话累计拦截的发送次数" }, String(n)) : null,
			);
		}

		function traceRows() {
			const t = store.trace;
			if (!t) return null;
			const rows = [...(t.normal || []).map((x) => ({ ...x, phase: "查证" })), ...(t.capped || []).map((x) => ({ ...x, phase: "收尾" }))];
			if (rows.length === 0) {
				return h("div", { className: "dpo-trace", "data-dpo": "trace" }, h("div", { className: "dpo-trace-empty" }, "（暂无查证动作）"));
			}
			return h("div", { className: "dpo-trace", "data-dpo": "trace" },
				h("div", { className: "dpo-trace-head" }, "查证动作 " + rows.length + " 步" + (rows.length > 8 ? "（仅列前 8 步）" : "") + (t && t.converged ? " · 已达轮次上限并收敛" : "")),
				...rows.slice(0, 8).map((r, i) => h("div", { key: i, className: "dpo-trace-row", "data-dpo": "trace-row" },
					h("span", { className: "dpo-trace-tool" }, "r" + r.round + " " + r.tool),
					h("span", { className: "dpo-trace-args" }, ((j) => (j.length > 46 ? j.slice(0, 46) + "…" : j))(JSON.stringify(r.args || {}))),
					h("span", { className: "dpo-trace-meta" }, String(r.ms) + "ms · " + String(r.resultLines) + "行"),
				)),
			);
		}

		/* 拖动位置（会话内存内保留）+ 边界夹紧 */
		const PANEL_MIN_W = 400;
		const PANEL_MIN_H = 320;
		function clampPos(x, y, panel) {
			const w = panel ? panel.offsetWidth : (store.overlaySize && store.overlaySize.w) || 520;
			const h = panel ? panel.offsetHeight : 320;
			const maxX = Math.max(8, window.innerWidth - w - 8);
			const maxY = Math.max(8, window.innerHeight - h - 8);
			return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
		}
		/** 尺寸夹紧：不小于最小值，也不超出视口（浏览器缩小后仍完整可见）。 */
		function clampSize(w, h) {
			const maxW = Math.max(PANEL_MIN_W, window.innerWidth - 16);
			const maxH = Math.max(PANEL_MIN_H, window.innerHeight - 16);
			const out = {};
			if (w !== null && w !== undefined) out.w = Math.min(Math.max(PANEL_MIN_W, Math.round(w)), maxW);
			if (h !== null && h !== undefined) out.h = Math.min(Math.max(PANEL_MIN_H, Math.round(h)), maxH);
			return out;
		}
		/** 把当前尺寸/位置落到 DOM 与 store（不开渲染，供拖动帧内使用）。 */
		function applyGeom(panel) {
			if (!panel) return;
			const size = store.overlaySize || {};
			if (size.w) panel.style.width = size.w + "px";
			panel.style.height = size.h ? size.h + "px" : "auto";
			panel.style.maxHeight = size.h ? "none" : "min(78vh,660px)";
			const pos = store.overlayPos || { x: 0, y: 0 };
			panel.style.transform = "translate3d(" + pos.x + "px," + pos.y + "px,0)";
		}
		/** 重新夹紧并写回（开窗、窗口缩放、改尺寸后统一走这里）。 */
		function reflowOverlay(panel) {
			const p = panel || (typeof document !== "undefined" ? document.querySelector('[data-dpo="overlay"]') : null);
			if (!p) return null;
			if (store.overlaySize && store.overlaySize.w) {
				const fixed = clampSize(store.overlaySize.w, store.overlaySize.h || null);
				store.overlaySize = Object.assign({}, store.overlaySize, fixed);
			}
			applyGeom(p);
			const base = store.overlayPos || { x: 8, y: 8 };
			store.overlayPos = clampPos(base.x, base.y, p);
			p.style.transform = "translate3d(" + store.overlayPos.x + "px," + store.overlayPos.y + "px,0)";
			return store.overlayPos;
		}

		/* ══════════ 实时优化运行（小类 3.2：SSE 双通道 → 浮层分区渲染） ══════════ */
		/** 确定回退：停止后端运行 + 关浮层 + 不发消息；输入框原文保持不动。 */
		function rollbackYes() {
			const run = store.run;
			const original = run ? String(run.request || "") : "";
			store.rollbackConfirm = false;
			if (run && run.es) { try { run.es.close() } catch (e) { /* noop */ } }
			if (run && run.runId) {
				fetch(API + "/run/abort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: run.runId }) }).catch(() => {});
			}
			store.run = null;
			store.reviewText = null;
			store.regenAsk = false;
			setOverlay({ open: false });
			// 原文还原：拦截发生在发送之前，草稿通常仍在；若被清空则显式写回
			try {
				if (original && store.latest.actions && original !== draftLive()) store.latest.actions.setDraft(original);
			} catch (e) { /* noop */ }
			beacon("rollback-done", { restored: original.slice(0, 40), draft: String(draftLive() || "").slice(0, 40) });
			showNotice("已回退：优化已停止，输入框原文保留");
			emit();
		}

		/** 浮层几何自检：可见性出问题时留下可判定的证据（"弹窗消失"类缺陷）。 */
		function beaconOverlayGeom(stage) {
			try {
				const el = document.querySelector('[data-dpo="overlay"]');
				if (!el) { beacon("overlay-geom", { stage, exists: false, open: store.overlay.open === true }); return; }
				const r = el.getBoundingClientRect();
				const cs = getComputedStyle(el);
				const centerEl = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
				beacon("overlay-geom", {
					stage, exists: true,
					rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
					viewport: { w: window.innerWidth, h: window.innerHeight },
					inView: r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
					display: cs.display, visibility: cs.visibility, opacity: cs.opacity, zIndex: cs.zIndex, overflow: cs.overflow,
					headVisible: Boolean(document.querySelector('[data-dpo="drag-handle"]')),
					hitIsOurs: Boolean(centerEl && centerEl.closest && centerEl.closest('[data-dpo="overlay"]')),
					scrollH: el.scrollHeight, clientH: el.clientHeight,
				});
			} catch (e) { beacon("overlay-geom", { stage, error: String(e) }); }
		}

		/** 接线：拦截到"发送"后真正启动优化（档位/权限决定后续自动提交或转审查态）。 */
		function interceptAndOptimize(text) {
			const body = String(text || "").trim();
			if (!body) return;
			// 已有 run 在跑：绝不静默起第二个（否则第一个被覆盖，用户会感觉"发出去了但没反应"）
			const busy = store.run && (store.run.status === "connecting" || store.run.status === "running");
			const awaitingReview = store.run && store.run.status === "done" && store.permission === "review";
			if (busy || awaitingReview) {
				beacon("dup-intercept", { status: store.run.status, chars: body.length, kind: busy ? "busy" : "awaiting-review" });
				showNotice(busy ? "优化中 · 见浮窗" : "已拦截 · 见浮窗");
				setOverlay({ open: true, src: busy ? "dup" : "review", blocked: true });
				return;
			}
			const tier = store.tier === "off" ? "basic" : store.tier;
			record("optimize-start", body, { tier, permission: store.permission, sessionId: store.viewSessionId });
			setOverlay({ open: true, text: body, fullText: body, src: "optimize", sessionId: store.viewSessionId, blocked: false });
			startRun(body, tier, false);
		}

		function startRun(request, tier, forceError, opts) {
			const extra = opts || {};
			const sid = store.viewSessionId || null;
			if (store.run && store.run.es) { try { store.run.es.close() } catch (e) { /* noop */ } }
			const run = {
				status: "connecting", reasoning: "", text: "", error: null,
				startedAt: Date.now(), firstPaintMs: null, request, tier,
				forceError: forceError === true, runId: null, es: null,
				direction: extra.direction || null, version: (extra.version || 1),
				sessionId: sid, readyToSend: null, disposed: false,
			};
			store.run = run;
			store.reviewText = null;
			store.regenAsk = false;
			setOverlay({ open: true, text: String(request || ""), fullText: String(request || ""), src: "run", sessionId: sid, blocked: false });
			emit();
			/** 自动档要把结果发出去：只有"该会话正在被查看"时才有 composer 可提交，否则挂起等切回。 */
			const autoSend = (text, noticeText) => {
				const isView = (run.sessionId || null) === (store.viewSessionId || null);
				const out = String(text || "");
				if (!out) return false;
				if (isView && store.latest.actions) {
					store.overlay.open = false;
					store.run = null;
					store.reviewText = null;
					store.latest.actions.setDraft(out);
					store.latest.actions.submit();
					if (noticeText) showNotice(noticeText);
					emit();
					return true;
				}
				run.readyToSend = out;
				beacon("auto-send-deferred", { sessionId: run.sessionId, view: store.viewSessionId, chars: out.length });
				showNotice("另一会话的优化已完成，切回该会话即自动发送");
				return false;
			};
			fetch(API + "/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ request, tier, sessionId: sid || store.latest.sessionId, forceError: forceError === true, provider: store.modelSel ? store.modelSel.provider : null, model: store.modelSel ? store.modelSel.model : null, direction: extra.direction || null, prevText: extra.prevText || null }),
			}).then((r) => r.json()).then((d) => {
				if (!d || d.ok !== true) { run.status = "error"; run.error = "启动失败：" + JSON.stringify(d); emit(); return; }
				run.runId = d.runId;
				const es = new EventSource(API + "/stream?runId=" + encodeURIComponent(d.runId));
				run.es = es;
				es.onmessage = (ev) => {
					if (run.disposed) return;
					let msg = null;
					try { msg = JSON.parse(ev.data) } catch (e) { return; }
					const cur = run; // 绑定本 run 自身：即使被切到别的会话（暂存）也继续收流
					if (msg.type === "snapshot") {
						cur.reasoning = msg.reasoning || "";
						cur.text = msg.text || "";
						if (msg.usage) cur.usage = msg.usage;
						if (msg.status && msg.status !== "running") cur.status = msg.status;
						if (msg.error) cur.error = msg.error;
						if (cur.firstPaintMs === null && (cur.reasoning || cur.text)) cur.firstPaintMs = Date.now() - cur.startedAt;
					} else if (msg.type === "reasoning-delta" || msg.type === "text-delta") {
						if (msg.type === "reasoning-delta") cur.reasoning += msg.text; else cur.text += msg.text;
						if (cur.firstPaintMs === null) cur.firstPaintMs = Date.now() - cur.startedAt;
						cur.status = "running";
					} else if (msg.type === "usage") {
						let u = null;
						try {
							u = typeof msg.usage === "string" ? JSON.parse(msg.usage)
								: (msg.usage || (typeof msg.text === "string" ? JSON.parse(msg.text) : null));
						} catch (e) { u = null; }
						if (u && typeof u === "object") {
							cur.usage = u;
							if (cur.usageBeaconed !== true) {
								cur.usageBeaconed = true;
								beacon("usage-delta", { keys: Object.keys(u).slice(0, 10), reasoning: reasoningTokensOf(u), total: u.totalTokens || u.total_tokens || null, tier: cur.tier });
							}
						}
					} else if (msg.type === "aborted") {
						cur.status = "aborted";
					} else if (msg.type === "error") {
						cur.status = "error";
						cur.error = msg.message || "未知错误";
						// 死模型自愈：provider 不接 / 连不上 → 清掉落盘的模型选择，下次回默认
						const deadRoute = /NO_ADAPTER|TRANSPORT|no adapter registered|Connection error|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(String(cur.error || ""));
						if (deadRoute) {
							store.modelSel = null;
							persistState({ tier: store.tier, permission: store.permission, model: null });
							beacon("model-selfheal", { reason: String(cur.error || "").slice(0, 120) });
						}
						// 自动档：优化失败也要把用户的消息发出去（fail-open），绝不静默吞掉
						if (store.permission === "auto") {
							const original = String(cur.request || "");
							autoSend(original, deadRoute ? "优化模型不可用 → 已按原文发出，并回退到默认模型" : "优化失败 → 已按原文发出");
							beacon("fail-open-send", { kind: "error", deadRoute, originalChars: original.length, reason: String(cur.error || "").slice(0, 120) });
						}
					} else if (msg.type === "done") {
						cur.status = "done";
						if (store.permission === "auto" && String(cur.text || "").trim()) {
							autoSend(String(cur.text), "已按 " + cur.tier + " 档优化结果发送");
						} else if (store.permission === "auto") {
							// 空产出也放行原文：宁可按原文发出，也不要"按了发送却什么都没发生"
							const original = String(cur.request || "");
							autoSend(original, "优化未产出内容 → 已按原文发出");
							beacon("fail-open-send", { kind: "empty-done", originalChars: original.length });
						} else {
							// 审查态：确保浮层处于打开状态，双按钮在粘底操作区内
							cur.regenAsk = false;
							if ((cur.sessionId || null) === (store.viewSessionId || null) || cur.sessionId === null) setOverlay({ open: true, src: "review", sessionId: cur.sessionId, blocked: false });
							beacon("review-ready", { chars: String(cur.text || "").length, tier: cur.tier, permission: store.permission, sessionId: cur.sessionId, isView: (cur.sessionId || null) === (store.viewSessionId || null) });
							window.setTimeout(() => { beaconOverlayGeom("review-ready"); }, 80);
							try {
								window.setTimeout(() => {
									const el = document.querySelector('[data-dpo="review"]');
									if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
								}, 60);
							} catch (e) { /* noop */ }
						}
					}
					if (cur.status !== "running" && cur.status !== "connecting" && cur.es) { try { cur.es.close() } catch (e) { /* noop */ } cur.es = null; }
					emit();
				};
				es.onerror = () => { /* 连接中断：保留已收内容，状态由事件决定 */ };
			}).catch((e) => {
				run.status = "error"; run.error = String(e); emit();
			});
		}

		function humanizeError(raw) {
			const s = String(raw || "");
			if (s.includes("NO_ADAPTER")) return "该模型供应商未注册（没有可用适配器）——请在优化模型里换一个可用的 provider";
			if (s.includes("ABORTED")) return "请求已被取消（回退或超时）";
			if (s.includes("no-llm-route")) return "找不到可用的模型路由（请先选一个优化模型）";
			if (/401|unauthor/i.test(s)) return "凭据无效或未授权（请检查该 provider 的 API Key）";
			if (/429|rate.?limit/i.test(s)) return "请求过于频繁，请稍后重试";
			if (/timeout|ETIMEDOUT/i.test(s)) return "请求超时，可重试";
			return s.length > 160 ? s.slice(0, 160) + "…" : s;
		}

		/** token 数格式化：1234 → 1.2k；缺失则返回 null（有些 provider 不上报用量）。 */
		function fmtTokens(n) {
			const v = Number(n);
			if (!Number.isFinite(v) || v <= 0) return null;
			return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k" : String(Math.round(v));
		}
		/** 从 usage 里挑"思考消耗"：优先 reasoningTokens，其次 completion 里的 reasoning 明细。 */
		function reasoningTokensOf(usage) {
			if (!usage || typeof usage !== "object") return null;
			const direct = usage.reasoningTokens || usage.reasoning_tokens || (usage.details && (usage.details.reasoningTokens || usage.details.reasoning_tokens));
			if (Number.isFinite(Number(direct))) return Number(direct);
			return null;
		}
		function usageChips(usage) {
			if (!usage || typeof usage !== "object") return null;
			const rt = fmtTokens(reasoningTokensOf(usage));
			const out = fmtTokens(usage.outputTokens || usage.completionTokens || usage.output_tokens);
			const tot = fmtTokens(usage.totalTokens || usage.total_tokens);
			return { reasoning: rt, output: out, total: tot };
		}

		/** 运行中让面板跟随滚动（用户手动上滚时不抢），流式产出看起来是"活"的。 */
		function liveScroll(el) {
			if (!el) return;
			const st = store.run && store.run.status;
			if (st !== "running" && st !== "connecting") return;
			if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) el.scrollTop = el.scrollHeight;
		}

		function runPanes() {
			const run = store.run;
			if (!run) return null;
			const live = run.status === "running" || run.status === "connecting";
			const emptyOf = (what) => (live ? "（等待" + what + "…）" : run.status === "error" ? "（优化中断，无" + what + "内容）" : "（本次没有" + what + "内容）");
			const chips = usageChips(run.usage);
			const label = run.status === "running" || run.status === "connecting" ? "优化中…"
				: run.status === "done" ? "已完成" : run.status === "error" ? "失败" : run.status;
			return h("div", { className: "dpo-run", "data-dpo": "run" },
				h("div", { className: "dpo-run-status", "data-dpo": "run-status", "aria-live": "polite" },
					"档位 " + ((TIERS.find((x) => x.id === run.tier) || {}).label || run.tier) + " · " + label + (run.firstPaintMs !== null ? " · 首字 " + run.firstPaintMs + "ms" : ""),
					chips && chips.total ? h("span", { className: "dpo-tok-chip", "data-dpo": "token-total", title: "本次优化总 token" }, "Σ " + chips.total + " tok") : null,
					live && !chips ? h("span", { className: "dpo-tok-chip dpo-tok-live", "data-dpo": "token-wait", title: "等待 provider 上报用量" }, "tok …") : null,
				),
				h("div", { className: "dpo-pane", "data-dpo": "pane-reasoning", "data-kind": "reasoning", "data-live": String(live && !run.reasoning), "aria-busy": String(Boolean(live && !run.reasoning)) },
					h("div", { className: "dpo-pane-title" },
						"思考",
						chips && chips.reasoning
							? h("span", { className: "dpo-tok-chip", "data-dpo": "token-reasoning", title: "本次思考消耗 token（provider 上报）" }, chips.reasoning + " tok")
							: h("span", { className: "dpo-tok-chip dpo-tok-muted", "data-dpo": "token-reasoning-none", title: "该 provider 未上报思考 token" }, "— tok"),
						run.reasoning ? h("span", { className: "dpo-tok-chip dpo-tok-muted", title: "思考字数" }, run.reasoning.length + " 字") : null,
					),
					h("div", { className: "dpo-pane-body", ref: liveScroll }, run.reasoning || emptyOf("思考")),
				),
				h("div", { className: "dpo-pane", "data-dpo": "pane-text", "data-kind": "text", "data-live": String(live && Boolean(run.reasoning)), "aria-busy": String(Boolean(live && Boolean(run.reasoning))) },
					h("div", { className: "dpo-pane-title" },
						"产出",
						chips && chips.output ? h("span", { className: "dpo-tok-chip", "data-dpo": "token-output", title: "产出的输出 token" }, chips.output + " tok") : null,
						run.text ? h("span", { className: "dpo-tok-chip dpo-tok-muted", title: "产出字数" }, run.text.length + " 字") : null,
					),
					h("div", { className: "dpo-pane-body", ref: liveScroll }, run.text || emptyOf("产出")),
				),
				run.status === "error"
					? h("div", { className: "dpo-run-error", "data-dpo": "run-error" },
						h("span", { title: String(run.error || "") }, "失败：" + humanizeError(run.error)),
					)
					: null,
			);
		}

		/** v99 · 复制优化结果（优先 Clipboard API，失败回退 execCommand）。 */
		function copyResult(btn) {
			const ta = document.querySelector('[data-dpo="review-text"]');
			if (!ta || !btn) return;
			const text = String(ta.value || "");
			const label = "复制";
			const flash = (next) => {
				btn.textContent = next;
				if (next === "已复制") btn.setAttribute("data-copied", "1"); else btn.removeAttribute("data-copied");
				window.setTimeout(() => { btn.textContent = label; btn.removeAttribute("data-copied"); }, 1400);
			};
			const legacy = () => {
				try {
					const start = ta.selectionStart, end = ta.selectionEnd;
					ta.focus(); ta.select();
					const ok = document.execCommand("copy");
					ta.setSelectionRange(start, end);
					flash(ok ? "已复制" : "复制失败");
				} catch (e) { flash("复制失败"); }
			};
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text).then(() => flash("已复制"), legacy);
				} else legacy();
			} catch (e) { legacy(); }
		}
		function reviewPane() {
			const run = store.run;
			if (!run || run.status !== "done") return null;
			const text = (store.reviewText !== undefined && store.reviewText !== null) ? store.reviewText : run.text;
			return h("div", { className: "dpo-review", "data-dpo": "review" },
				h("div", { className: "dpo-pane-title", "data-dpo": "review-hint" },
					"以下内容将原样发送（可直接编辑） · " + String(text || "").length + " 字",
					h("button", { type: "button", className: "dpo-copy", "data-dpo": "copy-review",
						title: "复制全部内容", onClick: (e) => copyResult(e.currentTarget) }, "复制")),
				store.regenAsk === true
					? h("div", { className: "dpo-regen-ask", "data-dpo": "regen-ask" },
						h("div", { className: "dpo-pane-title" }, "重新生成 · 给个方向（可留空）"),
						h("input", {
							className: "dpo-regen-input", "data-dpo": "regen-input", type: "text", "aria-label": "重新生成的方向（可留空）",
							placeholder: "例如：更短、保留技术细节、强调验收标准…",
							value: store.regenDir || "",
							onChange: (e) => { store.regenDir = e.target.value; emit(); },
							onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submitRegen(); } },
						}),
						h("div", { className: "dpo-hint-quiet" }, "回车即可重跑 · 留空则随机换一次方向"),
					)
					: null,
				h("textarea", {
					className: "dpo-review-text",
					"data-dpo": "review-text", "aria-label": "优化后的内容（可直接编辑）",
					value: text,
					spellCheck: false,
					onChange: (e) => { store.reviewText = e.target.value; emit(); },
				}),
			);
		}

		/** 按用户给的方向重跑（空方向＝直接重跑）。 */
		function submitRegen() {
			const cur = store.run;
			const dir = String(store.regenDir || "").trim();
			beacon("regen-go", { dir: dir.slice(0, 60) });
			store.regenAsk = false;
			if (!cur) return;
			const prev = (store.reviewText !== undefined && store.reviewText !== null) ? store.reviewText : cur.text;
			startRun(cur.request, cur.tier, false, { direction: dir || null, prevText: prev, version: (cur.version || 1) + 1 });
		}

		/** 确认提交：把（可能已编辑的）文本交回官方发送链路，随后关闭浮层。 */
		function confirmSubmit() {
			const run = store.run;
			const text = (store.reviewText !== undefined && store.reviewText !== null)
				? store.reviewText
				: (run ? run.text : "");
			setOverlay({ open: false });
			disposeRun();
			store.reviewText = null;
			if (text && store.latest.actions) {
				store.latest.actions.setDraft(text);
				store.latest.actions.submit();
			}
			emit();
		}

		/** 常驻底部操作栏：不在滚动区内 —— 无论弹窗多小、内容多长，关键按钮永不消失。 */
		function overlayFooter() {
			const run = store.run;
			const done = run && run.status === "done";
			const err = run && run.status === "error";
			if (store.regenAsk === true) {
				return h("div", { className: "dpo-overlay-actions", "data-dpo": "foot-regen" },
					h("button", { type: "button", className: "dpo-btn primary", "data-dpo": "regen-go", onClick: submitRegen }, "按此方向重跑"),
					h("button", { type: "button", className: "dpo-btn", "data-dpo": "regen-cancel", onClick: () => { store.regenAsk = false; emit(); } }, "取消"),
				);
			}
			if (done && store.permission === "review") {
				return h("div", { className: "dpo-overlay-actions", "data-dpo": "foot-review" },
					h("button", { type: "button", className: "dpo-btn primary", "data-dpo": "confirm", onClick: () => { beacon("confirm-click", {}); confirmSubmit(); } }, "确认提交"),
					h("button", {
						type: "button", className: "dpo-btn danger", "data-dpo": "regen",
						onClick: () => {
							beacon("regen-click", { hasRun: Boolean(store.run) });
							store.regenAsk = true;
							if (store.regenDir === undefined) store.regenDir = "";
							emit();
							window.setTimeout(() => { try { const el = document.querySelector('[data-dpo="regen-ask"]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); } catch (e) { /* noop */ } }, 80);
						},
					}, "重新生成"),
				);
			}
			if (err) {
				return h("div", { className: "dpo-overlay-actions", "data-dpo": "foot-error" },
					h("button", { type: "button", className: "dpo-btn", "data-dpo": "retry", onClick: () => startRun(run.request, run.tier, false) }, "重试"),
					h("button", { type: "button", className: "dpo-btn", "data-dpo": "reset-model", onClick: () => { store.modelSel = null; persistState({ tier: store.tier, permission: store.permission, model: null }); startRun(run.request, run.tier, false); } }, "默认模型重试"),
					h("button", { type: "button", className: "dpo-btn primary", "data-dpo": "release", onClick: releaseOriginal }, "按原文发出"),
				);
			}
			// 运行中 / 无运行 / 自动档：始终给一个"放行原文"的出口
			return h("div", { className: "dpo-overlay-actions", "data-dpo": "foot-idle" },
				h("button", { type: "button", className: "dpo-btn", "data-dpo": "rollback-here", onClick: () => { store.rollbackConfirm = true; emit(); window.setTimeout(() => { try { const el = document.querySelector('[data-dpo="rollback-confirm"]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); } catch (e) { /* noop */ } }, 80); } }, "‹ 回退"),
				h("button", { type: "button", className: "dpo-btn primary", "data-dpo": "release", onClick: releaseOriginal }, "放行本条（按原文发出）"),
			);
		}

		/**
		 * 停掉当前 run 的后台流。放行原文 / 确认提交后必须调用 —— 否则 SSE 的 done/error
		 * 仍会触发 autoSend（自动档会把优化结果再发一遍）或让浮窗复活。
		 * 与回退确认（:745）、startRun（:805）的既有做法保持一致。
		 */
		function disposeRun() {
			const cur = store.run;
			if (cur) {
				if (cur.es) { try { cur.es.close() } catch (e) { /* noop */ } cur.es = null; }
				cur.disposed = true;
			}
			store.run = null;
		}
		/** 放行原文（浮层与降级面板共用）：完整原文优先，绝不截断。 */
		function releaseOriginal() {
			const text = store.overlay.fullText || (store.run && store.run.request) || draftLive();
			beacon("release-original", { chars: String(text || "").length, from: store.overlay.fullText ? "fullText" : (store.run ? "run.request" : "draft") });
			setOverlay({ open: false });
			disposeRun();
			store.reviewText = null;
			if (text && store.latest.actions) {
				store.latest.actions.setDraft(text);
				store.latest.actions.submit();
			}
			emit();
		}

		/** 降级面板：任何渲染异常下依然给出「回退 / 放行原文」两个出口（浮层不再"无声消失"）。 */
		function OverlayFallback(props) {
			return h("div", {
				className: "dpo-overlay", "data-dpo": "overlay", "data-dpo-degraded": "1",
				style: { transform: "translate3d(" + Math.max(8, (window.innerWidth || 800) - 480) + "px,96px,0)" },
			},
				h("div", { className: "dpo-overlay-head", "data-dpo": "drag-handle" },
					h("button", { type: "button", className: "dpo-x", "data-dpo": "rollback", onClick: () => { store.rollbackConfirm = true; emit(); } }, "‹ 回退"),
					h("span", null, "提示词优化 · 渲染降级"),
					h("span", { className: "dpo-head-hint" }, "已记录错误"),
				),
				h("div", { className: "dpo-overlay-scroll" },
					store.rollbackConfirm === true
						? h("div", { className: "dpo-overlay-src", "data-dpo": "rollback-confirm" },
							h("span", null, "确定回退？将停止优化、关闭浮层，且不发送任何消息。"),
							h("button", { type: "button", className: "dpo-btn danger", "data-dpo": "rollback-yes", onClick: () => { beacon("rollback-yes", {}); rollbackYes(); } }, "确定回退"),
							h("button", { type: "button", className: "dpo-btn", "data-dpo": "rollback-no", onClick: () => { store.rollbackConfirm = false; emit(); } }, "取消回退"),
						)
						: null,
					h("div", { className: "dpo-overlay-body" }, "浮层渲染出错，已降级为最小面板（优化仍在后台进行）。错误：" + String(props && props.err || "未知")),
					h("div", { className: "dpo-overlay-actions" },
						h("button", { type: "button", className: "dpo-btn primary", "data-dpo": "release", onClick: releaseOriginal }, "放行本条（按原文发出）"),
					),
				),
			);
		}

		/** 错误边界：捕获浮层渲染/副作用异常 → 记录证据 + 渲染降级面板，而不是整块消失。 */
		class OverlayBoundary extends React.Component {
			constructor(props) { super(props); this.state = { err: null }; }
			static getDerivedStateFromError(error) { return { err: String((error && error.message) || error) }; }
			componentDidCatch(error, info) {
				beacon("overlay-error", {
					message: String((error && error.message) || error),
					stack: String((error && error.stack) || "").slice(0, 700),
					componentStack: String((info && info.componentStack) || "").slice(0, 700),
					runStatus: store.run ? store.run.status : null,
					permission: store.permission, tier: store.tier,
				});
			}
			render() { return this.state.err ? h(OverlayFallback, { err: this.state.err }) : this.props.children; }
		}
		const OverlayHost = () => h(OverlayBoundary, null, h(Overlay));

		function Overlay() {


			const [, force] = React.useState(0);
			const panelRef = React.useRef(null);
			const dragRef = React.useRef(null);
			const rafRef = React.useRef(0);
			const sizeRafRef = React.useRef(0);
			const pendingRef = React.useRef(null);
			const sizeRef = React.useRef(null); // ← 必须在任何 early return 之前（#310 事故根源）
			// 挂载/卸载埋点：若"开着却没有节点"，这里能区分"从未挂上"与"被卸载"
			React.useEffect(() => {
				beacon("overlay-mounted", { runStatus: store.run ? store.run.status : null, open: store.overlay.open === true });
				return () => { beacon("overlay-unmounted", { openNow: store.overlay.open === true, runStatus: store.run ? store.run.status : null }); };
			}, []);
			React.useEffect(() => {
				const fn = () => force((x) => x + 1);
				store.listeners.add(fn);
				return () => { store.listeners.delete(fn); };
			}, []);
			const open = store.overlay.open;
			// 开窗即夹紧：即便上一次在更宽的窗口里拖到右侧，也不会出现在视口之外
			React.useLayoutEffect(() => {
				if (!open) return undefined;
				const raf = requestAnimationFrame(() => { reflowOverlay(panelRef.current); beaconOverlayGeom("open"); force((x) => x + 1); });
				return () => cancelAnimationFrame(raf);
			}, [open]);
			// 窗口尺寸变化 → 重新夹紧（位置与尺寸都不越界）；卸载即注销监听
			React.useEffect(() => {
				if (!open) return undefined;
				const onResize = () => { reflowOverlay(panelRef.current); };
				store.resizeListeners = (store.resizeListeners || 0) + 1;
				window.addEventListener("resize", onResize);
				return () => {
					window.removeEventListener("resize", onResize);
					store.resizeListeners = Math.max(0, (store.resizeListeners || 0) - 1);
				};
			}, [open]);
			const o = store.overlay;
			if (!o.open) return null;
			// 会话隔离兜底：弹窗只属于它的会话
			if (o.sessionId !== undefined && o.sessionId !== null && store.viewSessionId !== null && o.sessionId !== store.viewSessionId) return null;
			if (!isActiveInstance()) return null; // 旧实例不再渲染浮层（否则会出现"后台在跑、弹窗不显示"）
			store.renderCount = (store.renderCount || 0) + 1;
			const applyPending = () => {
				rafRef.current = 0;
				const panel = panelRef.current;
				const next = pendingRef.current;
				if (!panel || !next) return;
				store.overlayPos = next;
				panel.style.transform = "translate3d(" + next.x + "px," + next.y + "px,0)";
			};
			const onPointerDown = (e) => {
				if (e.button !== 0) return;
				// 起点在按钮上时不启动拖动：preventDefault 会抑制兼容 click，导致「回退」「×」点不动
				const hit = e.target;
				if (hit && hit.closest && hit.closest("button")) return;
				const panel = panelRef.current;
				if (!panel) return;
				const rect = panel.getBoundingClientRect();
				dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
				try { panel.setPointerCapture(e.pointerId); } catch (err) { /* 合成指针无捕获 */ }
				e.preventDefault();
			};
			const onPointerMove = (e) => {
				const drag = dragRef.current;
				const panel = panelRef.current;
				if (!drag || !panel) return;
				pendingRef.current = clampPos(e.clientX - drag.dx, e.clientY - drag.dy, panel);
				if (rafRef.current === 0) rafRef.current = requestAnimationFrame(applyPending);
			};
			const onPointerUp = (e) => {
				if (!dragRef.current) return;
				dragRef.current = null;
				try { if (panelRef.current) panelRef.current.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
				if (rafRef.current !== 0) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
				applyPending();
				beacon("overlay-move", { pos: store.overlayPos });
				persistUi();
			};
			/* 右下角改尺寸（自定义弹窗大小，落盘记住）—— sizeRef 已提到组件顶部 */
			/** 提交一份尺寸（显式传值，不依赖 sizeRef 的生命周期）。 */
			const commitSize = (size) => {
				const panel = panelRef.current;
				if (!panel || !size || size.w === undefined) return false;
				store.overlaySize = { w: size.w, h: size.h === undefined ? null : size.h };
				applyGeom(panel);
				store.overlayPos = clampPos((store.overlayPos || { x: 8 }).x, (store.overlayPos || { y: 8 }).y, panel);
				panel.style.transform = "translate3d(" + store.overlayPos.x + "px," + store.overlayPos.y + "px,0)";
				return true;
			};
			const applyPendingSize = () => {
				sizeRafRef.current = 0;
				commitSize(sizeRef.current);
			};
			const onSizeDown = (e) => {
				if (e.button !== 0) return;
				const panel = panelRef.current;
				if (!panel) return;
				e.preventDefault();
				e.stopPropagation();
				const rect = panel.getBoundingClientRect();
				sizeRef.current = Object.assign({ startX: e.clientX, startY: e.clientY, w0: rect.width, h0: rect.height });
				try { panel.setPointerCapture(e.pointerId); } catch (err) { /* 合成指针无捕获 */ }
				beacon("resize-start", { w: Math.round(rect.width), h: Math.round(rect.height) });
			};
			const onSizeMove = (e) => {
				const st = sizeRef.current;
				const panel = panelRef.current;
				if (!st || !panel || st.w0 === undefined) return;
				const next = clampSize(st.w0 + (e.clientX - st.startX), st.h0 + (e.clientY - st.startY));
				sizeRef.current = Object.assign({}, st, next);
				if (sizeRafRef.current === 0) sizeRafRef.current = requestAnimationFrame(applyPendingSize);
			};
			const onSizeUp = (e) => {
				const st = sizeRef.current;
				if (!st) return;
				// 关键：先用当前拖拽值提交，再清状态 —— 否则最后一次位移（快速拖拽时是全部）会被丢掉
				if (sizeRafRef.current !== 0) { cancelAnimationFrame(sizeRafRef.current); sizeRafRef.current = 0; }
				const committed = commitSize(st);
				sizeRef.current = null;
				try { if (panelRef.current) panelRef.current.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
				beacon("resize-done", { size: store.overlaySize, committed, moved: { dx: Math.round(e.clientX - st.startX), dy: Math.round(e.clientY - st.startY) } });
				persistUi();
				emit();
			};
			const base = store.overlayPos || { x: Math.max(8, window.innerWidth - 480), y: 96 };
			const pos = clampPos(base.x, base.y, null);
			store.overlayPos = pos;
			const size = store.overlaySize || {};
			const panelStyle = { transform: "translate3d(" + pos.x + "px," + pos.y + "px,0)" };
			if (size.w) panelStyle.width = size.w + "px";
			panelStyle.height = size.h ? size.h + "px" : "auto";
			panelStyle.maxHeight = size.h ? "none" : "min(78vh,660px)";
			return h("div", {
				ref: panelRef,
				className: "dpo-overlay" + (dragRef.current ? " dpo-dragging" : "") + (sizeRef.current ? " dpo-sizing" : ""),
				"data-dpo": "overlay", role: "dialog", "aria-label": "提示词优化浮窗",
				"data-state": (() => { const st = store.run ? store.run.status : null; return st === "running" || st === "connecting" ? "running" : st === "done" ? "done" : st === "error" ? "error" : "idle"; })(),
				style: panelStyle,
				onPointerMove: (e) => { onSizeMove(e); onPointerMove(e); },
				onPointerUp: (e) => { onSizeUp(e); onPointerUp(e); },
				onPointerCancel: (e) => { onSizeUp(e); onPointerUp(e); },
			},
				h("div", { className: "dpo-overlay-head", "data-dpo": "drag-handle", onPointerDown, title: "按住拖动（右下角可改大小）" },
					h("button", { type: "button", className: "dpo-x", "data-dpo": "rollback", title: "回退：停掉本次优化并保留输入框原文", onClick: () => { beacon("rollback-click", { confirm: store.rollbackConfirm === true }); store.rollbackConfirm = true; emit(); } }, "‹ 回退"),
					h("span", null, "提示词优化 · 已拦截"),
					h("span", { className: "dpo-head-hint" }, store.overlaySize && store.overlaySize.w ? (store.overlaySize.w + "×" + (store.overlaySize.h || "自动")) : "↘ 可改大小"),
				),
				store.overlay.blocked === true
					? h("div", { className: "dpo-blocked", "data-dpo": "blocked", role: "status" },
						store.overlay.src === "dup"
							? "优化进行中 · 你的输入已保留在输入框，可稍候或点「回退」"
							: "上一次的结果还没确认 · 你的输入已保留在输入框，请先「确认提交」或「回退」")
					: null,
				h("div", { className: "dpo-overlay-scroll" },
					h("div", { className: "dpo-overlay-src" }, "发送：" + (PERMISSIONS.find((x) => x.id === store.permission) || {}).label + " · 拦截累计 " + store.intercepts.length),
					store.rollbackConfirm === true
						? h("div", { className: "dpo-overlay-src", "data-dpo": "rollback-confirm" },
							h("span", null, "确定回退？将停止优化、关闭浮层，且不发送任何消息。"),
							h("button", { type: "button", className: "dpo-btn danger", "data-dpo": "rollback-yes", onClick: () => { beacon("rollback-yes", {}); rollbackYes(); } }, "确定回退"),
							h("button", { type: "button", className: "dpo-btn", "data-dpo": "rollback-no", onClick: () => { beacon("rollback-no", {}); store.rollbackConfirm = false; emit(); } }, "取消回退"),
						)
						: null,
					runPanes(),
					reviewPane(),
					o.text ? h("div", { className: "dpo-orig", "data-dpo": "orig" }, h("div", { className: "dpo-pane-title" }, "你的原文"), h("div", { className: "dpo-overlay-body" }, o.text)) : null,
					traceRows(),
				),
				// 常驻操作栏：在滚动区之外 —— 弹窗再小、内容再长，关键按钮都不会被滚走或裁掉
				h("div", { className: "dpo-overlay-foot", "data-dpo": "overlay-foot" },
					h("div", { className: "dpo-foot-inner" }, overlayFooter()),
				),
				h("div", {
					className: "dpo-size-grip", "data-dpo": "resize", role: "separator", "aria-label": "拖动改大小（记住）", title: "拖动改大小（记住）",
					onPointerDown: onSizeDown,
				}),
			);
		}

		/* ══════════ 探针：合成手势 → 观察 → 报告 ══════════ */
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

		function dispatchKey(target, init, tag) {
			const cfg = Object.assign({ key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true }, init || {});
			const ev = new KeyboardEvent("keydown", cfg);
			ev.__dpoTag = tag || "dpo";
			try { Object.defineProperty(ev, "keyCode", { get: () => (cfg.isComposing ? 229 : 13) }); } catch (e) { /* noop */ }
			target.dispatchEvent(ev);
			return ev;
		}
		function dispatchClick(target, tag) {
			const ev = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window });
			ev.__dpoTag = tag || "dpo";
			target.dispatchEvent(ev);
			return ev;
		}
		/** 冒泡期间谍：只认本次派发的那个事件，用户真实按键记为 other（不污染判定）。 */
		const probeArtifacts = new Set();
		function releaseProbeArtifacts() {
			for (const fn of [...probeArtifacts]) { try { fn(); } catch (e) { /* noop */ } }
			probeArtifacts.clear();
		}
		function spyBubble(type, tag) {
			const box = { reached: false, other: 0 };
			const fn = (e) => {
				if (!tag) { box.reached = true; return; }
				if (e.__dpoTag === tag) box.reached = true;
				else box.other += 1;
			};
			window.addEventListener(type, fn, false);
			const stop = () => { window.removeEventListener(type, fn, false); probeArtifacts.delete(stop); };
			probeArtifacts.add(stop);
			return { box, stop };
		}

		async function post(path, body) {
			const res = await fetch(API + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			return res.json().catch(() => ({}));
		}

		/** 若应用在"本应被拦"的路径上仍把消息排进官方队列，则请宿主撤销该待处理项（零污染）。 */
		async function cleanupQueued(ctx, marker) {
			const snap = sessionOf();
			const row = (snap.queue || []).find((r) => String(r.text || "").includes(marker));
			if (!row) return { found: false };
			let removed = false;
			let error = null;
			try {
				const res = await post("/queued/remove", { sessionId: store.latest.sessionId, itemId: row.id });
				if (!res || res.ok !== true) error = (res && res.error) || "remove-failed";
				await sleep(700);
				removed = !(sessionOf().queue || []).some((r) => r.id === row.id);
			} catch (e) { error = String(e); }
			return { found: true, itemId: row.id, removed, error };
		}

		async function runProbe(ctx, token) {
			releaseProbeArtifacts();
			const steps = [];
			// 探针会改写档位/权限/浮层几何：先快照，收尾时还原成用户的值（探针不得改变用户配置）
			const uiSnapshot = {
				tier: store.tier,
				permission: store.permission,
				size: store.overlaySize ? Object.assign({}, store.overlaySize) : null,
				pos: store.overlayPos ? Object.assign({}, store.overlayPos) : null,
			};
			store.probeUiSnapshot = uiSnapshot;
			const push = (id, name, action, expected, observed, pass) =>
				steps.push({ id, name, action, expected, observed, pass: pass === true });
			const windowStart = Date.now();
			const actions = store.latest.actions;
			const initialDraft = draftFromHook();
			const card = cardOf(store.node);
			const editor = editorOf(card);
			const sendBtn = sendButtonOf(card);
			const pill = card ? card.querySelector('[data-dpo="pill"]') : null;

			push("S0", "骨架在位", "读取真实 DOM 结构",
				"卡片/编辑器/发送按钮均定位到",
				{
					card: Boolean(card), editor: Boolean(editor), sendButton: Boolean(sendBtn),
					sendLabel: sendBtn ? sendBtn.getAttribute("aria-label") : null,
					labelSet: [...SEND_LABELS],
					cardButtons: buttonsOf(card).map((b) => b.getAttribute("aria-label")),
					lastButton: lastButtonOf(card) ? lastButtonOf(card).getAttribute("aria-label") : null,
					sessionId: String(store.latest.sessionId || ""),
					running: runningNow(),
					actions: Boolean(actions),
				},
				Boolean(card && editor && sendBtn && actions));

			// ENV 闸门：环境不齐备就整轮中止，避免在被切换后的会话上误测（t15 的教训）
			const envPerm = buttonsOf(card).find((b) => String(b.getAttribute("aria-label")).includes("访问模式"));
			const envModel = buttonsOf(card).find((b) => String(b.getAttribute("aria-label")).includes("选择模型"));
			const envReady = Boolean(card && editor && actions && envPerm && envModel);
			if (!envReady && !(window.__DPO_FORCE_ENV__ === true)) {
				const aborted = {
					plugin: NS, token, kind: "selftest-aborted", reason: "environment-not-ready",
					sessionId: String(store.latest.sessionId || ""), windowStart, windowEnd: Date.now(),
					env: {
						card: Boolean(card), editor: Boolean(editor), actions: Boolean(actions),
						permissionSelect: Boolean(envPerm), modelSeat: Boolean(envModel), running: runningNow(),
					},
					steps, passed: 0, total: steps.length,
				};
				try { await post("/report", aborted); } catch (e) { /* noop */ }
				window.__DPO_PROBE_RUNNING__ = false;
				return aborted;
			}

			if (editor && actions) {
				// ── E2：IME 组合态回车不得误拦 ──
				setOverlay({ open: false });
				if (actions) actions.setDraft("DPO-IME-组合态测试");
				await frame();
				if (editor) editor.focus();
				const before2 = store.intercepts.length;
				const spy2 = spyBubble("keydown", "e2");
				const ev2 = dispatchKey(editor, { isComposing: true }, "e2");
				await sleep(400);
				spy2.stop();
				const clean2 = await cleanupQueued(ctx, "DPO-IME-组合态测试");
				const pass2 = store.intercepts.length === before2 && !store.overlay.open;
				push("E2", "IME 组合态回车不误拦",
					"setDraft→focus→派发 isComposing:true 的 Enter",
					"拦截计数不变、占位浮层不出现、消息不落库",
					{ interceptsBefore: before2, interceptsAfter: store.intercepts.length, overlayOpen: store.overlay.open, defaultPrevented: ev2.defaultPrevented, reachedBubble: spy2.box.reached, other: spy2.box.other, queuedCleanup: clean2 },
					pass2);
				if (actions) actions.setDraft("");
				await frame();

				// ── E1：正常回车必须被拦 ──
				setOverlay({ open: false });
				if (actions) actions.setDraft("DPO-回车拦截测试：把那个东西弄一下");
				await frame();
				if (editor) editor.focus();
				const before1 = store.intercepts.length;
				const spy1 = spyBubble("keydown", "e1");
				const ev1 = dispatchKey(editor, {}, "e1");
				await sleep(400);
				spy1.stop();
				const last1 = store.intercepts[store.intercepts.length - 1] || {};
				const clean1 = await cleanupQueued(ctx, "DPO-回车拦截测试");
				const pass1 = store.intercepts.length === before1 + 1 && store.overlay.open === true && spy1.box.reached === false;
				push("E1", "正常回车被拦截",
					"setDraft→focus→派发普通 Enter",
					"拦截计数 +1、占位浮层出现、事件未传播到冒泡期、消息不落库",
					{ interceptsBefore: before1, interceptsAfter: store.intercepts.length, overlayOpen: store.overlay.open, overlaySrc: store.overlay.src, overlayText: String(store.overlay.text).slice(0, 60), reachedBubble: spy1.box.reached, other: spy1.box.other, defaultPrevented: ev1.defaultPrevented, interceptedKind: last1.kind, queuedCleanup: clean1 },
					pass1);
				if (actions) actions.setDraft("");
				setOverlay({ open: false });
				await frame();

				// ── E4：对照——非发送按钮一律不得被拦（逐按钮求值 + 编辑器点击行为） ──
				setOverlay({ open: false });
				if (actions) actions.setDraft("DPO-对照测试：随便写点什么");
				await frame();
				const cardNow = cardOf(store.node);
				const table = buttonsOf(cardNow).map((b) => ({
					label: b.getAttribute("aria-label"),
					would: wouldInterceptClick(b),
					byLabel: isSendLabel(b.getAttribute("aria-label")),
					isLast: lastButtonOf(cardNow) === b,
					isStop: STOP_LABELS.has(b.getAttribute("aria-label") || ""),
				}));
				const trueCount = table.filter((r) => r.would).length;
				const before4 = store.intercepts.length;
				if (editor) dispatchClick(editor, "e4");
				await sleep(200);
				const pass4 = trueCount === 1 && store.intercepts.length === before4;
				push("E4", "非发送按钮不拦截（对照）",
					"对卡片内每个按钮求值 wouldInterceptClick + 向编辑器派发 click",
					"仅发送按钮被判为接管（1 个 true）；编辑器点击不触发拦截",
					{ table, trueCount, interceptsBefore: before4, interceptsAfter: store.intercepts.length },
					pass4);
				setOverlay({ open: false });
				if (actions) actions.setDraft("");
				await frame();

				// ── E3：真实发送按钮 click 必须被拦（先放入草稿，主按钮此时才是"发送"角色） ──
				setOverlay({ open: false });
				if (actions) actions.setDraft("DPO-按钮拦截测试：把那个东西弄一下");
				await frame();
				const liveSend = sendButtonOf(card) || sendBtn;
				const before3 = store.intercepts.length;
				let reachedClick = null;
				if (liveSend) {
					const spy3 = spyBubble("click", "e3");
					const ev3 = dispatchClick(liveSend, "e3");
					await sleep(400);
					spy3.stop();
					reachedClick = spy3.box.reached;
					const spy3Other = spy3.box.other;
					const clean3 = await cleanupQueued(ctx, "DPO-按钮拦截测试");
					const pass3 = store.intercepts.length === before3 + 1 && store.overlay.open === true && reachedClick === false;
					push("E3", "发送按钮 click 被拦截",
						"setDraft→派发 click 到主按钮（标签或结构位命中）",
						"拦截计数 +1、占位浮层出现、事件未传播、消息不落库",
						{ interceptsBefore: before3, interceptsAfter: store.intercepts.length, overlayOpen: store.overlay.open, overlaySrc: store.overlay.src, reachedBubble: reachedClick, other: spy3Other, label: liveSend.getAttribute("aria-label"), byLabel: isSendLabel(liveSend.getAttribute("aria-label")), isLast: lastButtonOf(card) === liveSend, defaultPrevented: ev3.defaultPrevented, queuedCleanup: clean3 },
						pass3);
				} else {
					push("E3", "发送按钮 click 被拦截", "派发 click 到真实发送按钮", "命中并拦截", { error: "未定位到发送按钮" }, false);
				}
				if (actions) actions.setDraft("");
				setOverlay({ open: false });
				await frame();

				// ── E5：setDraft → 投影回读（中文 / 超长） ──
				const cn = "中文草稿：把那个东西弄一下，尽量说清楚";
				if (actions) actions.setDraft(cn);
				await frame();
				const back1 = draftFromHook();
				const long = "长文本测试：" + "段落内容".repeat(300);
				if (actions) actions.setDraft(long);
				await frame();
				const back2 = draftFromHook();
				const pass5 = back1 === cn && back2 === long;
				push("E5", "setDraft 投影回读",
					"setDraft(中文) → 回读；setDraft(超长) → 回读",
					"两次回读与写入完全一致",
					{ cnLen: cn.length, cnBackLen: back1.length, cnEqual: back1 === cn, longLen: long.length, longBackLen: back2.length, longEqual: back2 === long },
					pass5);
				if (actions) actions.setDraft("");
				await frame();

				// ── E6：交付链路 + 正控（需会话 running，避免污染） ──
				if (!runningNow()) {
					push("E6", "交付链路+正控", "临时解除拦截后派发 Enter", "文本进入官方待处理队列并可撤销",
						{ skipped: true, reason: "会话当前非 running（idle 提交会直接落库，故意不测）" }, false);
				} else {
					const marker = "DPO-交付链路测试-" + token;
					store.armed = false;
					if (actions) actions.setDraft(marker);
					await frame();
					if (editor) editor.focus();
					const echoBefore = (sessionOf().pendingSubmissions || []).length;
					dispatchKey(editor, {}, "g");
					// 轮询等待"进入官方链路"的取证（最多 ~3.6s，避开单次采样竞态）
					let rowObserved = null;
					for (let i = 0; i < 12 && rowObserved === null; i += 1) {
						await sleep(300);
						rowObserved = (sessionOf().queue || []).find((r) => String(r.text || "").includes(marker)) || null;
					}
					const snap = sessionOf();
					const echoAfter = (snap.pendingSubmissions || []).length;
					// 宿主权威撤销：按文本匹配，不依赖客户端快照能否及时看到该行
					let removedByText = null;
					try { removedByText = await post("/queued/remove-by-text", { match: marker }); } catch (e) { removedByText = { error: String(e) }; }
					await sleep(700);
					const stillInQueue = (sessionOf().queue || []).some((r) => String(r.text || "").includes(marker));
					store.armed = true;
					if (actions) actions.setDraft("");
					const removedCount = removedByText && Array.isArray(removedByText.removed) ? removedByText.removed.length : 0;
					const pass6 = removedCount > 0 && stillInQueue === false;
					push("E6", "交付链路+正控",
						"解除拦截 → setDraft(标记文本) → 派发 Enter → 观察官方队列 → 宿主按文本权威撤销",
						"合成事件抵达官方发送入口（官方队列/收件箱出现该文本）、setDraft 内容被完整提交、撤销后队列干净",
						{ running: true, echoBefore, echoAfter, queuedRowObserved: Boolean(rowObserved), queuedText: rowObserved ? String(rowObserved.text).slice(0, 60) : null, removedByText, removedCount, stillInQueue },
						pass6);
				}
			}

			// ══════════ 1.2 三控件落位 ══════════
			const controlsEl = store.node;
			const cardF = cardOf(controlsEl);
			const rectOf = (el) => {
				if (!el) return null;
				const r = el.getBoundingClientRect();
				return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
			};
			const officialButtons = () => buttonsOf(cardF).filter((b) => b.getAttribute("aria-label") && !(b.closest && b.closest('[data-dpo="controls"]')));
			const snapshotRects = () => officialButtons().map((b) => ({ label: b.getAttribute("aria-label"), r: rectOf(b) }));
			const follows = (a, b) => Boolean(a && b) && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

			const tierEl = cardF ? cardF.querySelector('[data-dpo="tier"]') : null;
			const permEl = cardF ? cardF.querySelector('[data-dpo="perm"]') : null;
			const modelEl = cardF ? cardF.querySelector('[data-dpo="model"]') : null;
			const permOfficial = officialButtons().find((b) => String(b.getAttribute("aria-label")).includes("访问模式"));
			const modelOfficial = officialButtons().find((b) => String(b.getAttribute("aria-label")).includes("选择模型"));
			const sameRow = rectOf(tierEl) && rectOf(permOfficial) ? Math.abs(rectOf(tierEl).y - rectOf(permOfficial).y) <= 2 : false;
			const f1pass = Boolean(tierEl && permEl && modelEl && permOfficial && modelOfficial)
				&& follows(permOfficial, tierEl) && follows(tierEl, permEl) && follows(permEl, modelEl) && follows(modelEl, modelOfficial)
				&& sameRow;
			push("F1", "三控件落位",
				"定位三个控件，并与官方「访问模式」「选择模型」做文档顺序 + 几何核对",
				"三控件存在；顺序为 权限设置 → 档位 → 权限 → 模型入口 → 官方模型座位；与权限设置同一行",
				{
					exists: { tier: Boolean(tierEl), perm: Boolean(permEl), model: Boolean(modelEl), permOfficial: Boolean(permOfficial), modelOfficial: Boolean(modelOfficial) },
					order: { permBeforeTier: follows(permOfficial, tierEl), tierBeforePerm: follows(tierEl, permEl), permBeforeModel: follows(permEl, modelEl), modelBeforeOfficial: follows(modelEl, modelOfficial) },
					rects: { tier: rectOf(tierEl), perm: rectOf(permEl), model: rectOf(modelEl), permOfficial: rectOf(permOfficial), modelOfficial: rectOf(modelOfficial) },
					sameRow,
					text: { tier: tierEl ? tierEl.textContent : null, perm: permEl ? permEl.textContent : null, model: modelEl ? modelEl.textContent : null },
				},
				f1pass);

			const segBtn = (name, id) => (cardF ? cardF.querySelector('[data-dpo="' + name + "-" + id + '"]') : null);
			const permButtons = permEl ? Array.from(permEl.querySelectorAll("button")) : [];
			const tierBeforeF2 = store.tier;
			const permBeforeF2 = store.permission;
			const offBtn = segBtn("tier", "off");
			if (offBtn) dispatchClick(offBtn);
			await sleep(200);
			const offState = {
				tier: store.tier, armed: store.armed,
				disabled: permButtons.map((b) => b.disabled),
				permOpacity: permEl ? getComputedStyle(permEl).opacity : null,
			};
			const permBeforeClick = store.permission;
			if (permButtons[1]) dispatchClick(permButtons[1]);
			await sleep(120);
			const permAfterClickWhileOff = store.permission;
			const basicBtn = segBtn("tier", "basic");
			if (basicBtn) dispatchClick(basicBtn);
			await sleep(200);
			const onState = {
				tier: store.tier, armed: store.armed,
				disabled: permButtons.map((b) => b.disabled),
				permOpacity: permEl ? getComputedStyle(permEl).opacity : null,
			};
			if (permButtons[1]) dispatchClick(permButtons[1]);
			await sleep(120);
			const permAfterClickWhileOn = store.permission;
			const f2pass = permButtons.length === 2
				&& offState.disabled.every((d) => d === true)
				&& offState.armed === false
				&& permAfterClickWhileOff === permBeforeClick
				&& onState.disabled.every((d) => d === false)
				&& onState.armed === true
				&& permAfterClickWhileOn === "auto";
			push("F2", "档位=关闭 → 权限置灰联动",
				"真实点击「关闭」段 → 试点权限段 → 点回「普通」段 → 再点权限段",
				"关闭档：权限段 disabled 且点击无效、拦截停用；回到普通档：权限段恢复可点且能切换",
				{ offState, permBeforeClick, permAfterClickWhileOff, onState, permAfterClickWhileOn, permOpacityOff: offState.permOpacity, permOpacityOn: onState.permOpacity },
				f2pass);
			setPermission("review", "probe-reset");
			if (tierBeforeF2 !== store.tier) setTier(tierBeforeF2, "probe-restore");
			if (permBeforeF2 === "auto") setPermission("auto", "probe-restore");

			const beforeA = snapshotRects();
			if (controlsEl) controlsEl.style.display = "none";
			await frame();
			const withoutOurs = snapshotRects();
			if (controlsEl) controlsEl.style.display = "";
			await frame();
			const afterA = snapshotRects();
			const drift = [];
			for (const item of beforeA) {
				const other = withoutOurs.find((x) => x.label === item.label);
				if (!other) { drift.push({ label: item.label, missingWhenHidden: true }); continue; }
				if (Math.abs(other.r.x - item.r.x) > 1 || Math.abs(other.r.w - item.r.w) > 1 || Math.abs(other.r.y - item.r.y) > 1) {
					drift.push({ label: item.label, withOurs: item.r, hidden: other.r });
				}
			}
			const overflow = controlsEl ? { scrollW: controlsEl.scrollWidth, clientW: controlsEl.clientWidth } : null;
			const restored = beforeA.every((item) => {
				const back = afterA.find((x) => x.label === item.label);
				return back && Math.abs(back.r.x - item.r.x) <= 1 && Math.abs(back.r.w - item.r.w) <= 1;
			});
			const f3pass = beforeA.length >= 5 && drift.length === 0 && (!overflow || overflow.scrollW <= overflow.clientW + 1) && restored;
			push("F3", "零位移/零遮挡（A/B）",
				"记录官方控件 rect → 隐藏本插件控件 → 复测 → 恢复后再测",
				"隐藏前后官方控件 rect 完全一致（±1px）；本插件内容不横向溢出；恢复后位置回到原样",
				{ officialCount: beforeA.length, drift, overflow, restored, ourRect: rectOf(controlsEl), samples: beforeA.slice(0, 4) },
				f3pass);

			// ══════════ 1.3 手势边界与放行白名单 ══════════
			const fakeEnter = (over) => Object.assign({
				key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
				isComposing: false, keyCode: 13,
			}, over || {});
			const passRows = [];

			// G1：Shift+Enter 换行（真实派发）
			if (actions) actions.setDraft("DPO-换行测试");
			await frame();
			if (editor) editor.focus();
			let gBefore = store.intercepts.length;
			let gSpy = spyBubble("keydown", "g");
			dispatchKey(editor, { shiftKey: true }, "g");
			await sleep(300);
			gSpy.stop();
			passRows.push({
				id: "G1", name: "Shift+Enter 换行", mode: "真实派发",
				intercepted: store.intercepts.length > gBefore,
				reachedBubble: gSpy.box.reached,
				draftLenAfter: draftLive().length,
				hasNewline: draftLive().includes("\n"),
			});

			// G5：卡片外回车（临时 input 挂在 body 上，等价于设置页/重命名框）
			const outsideInput = document.createElement("input");
			outsideInput.setAttribute("data-dpo-probe", "outside");
			outsideInput.style.cssText = "position:fixed;left:-9999px;top:0";
			document.body.appendChild(outsideInput);
			probeArtifacts.add(() => { try { outsideInput.remove() } catch (e) { /* noop */ } });
			outsideInput.focus();
			await sleep(80);
			const gCard = cardOf(store.node);
			gBefore = store.intercepts.length;
			gSpy = spyBubble("keydown", "g");
			const g5Event = dispatchKey(outsideInput, {}, "g");
			await sleep(250);
			gSpy.stop();
			passRows.push({
				id: "G5", name: "卡片外回车（设置页/重命名框同类）", mode: "真实派发",
				activeOutsideCard: Boolean(gCard && !gCard.contains(document.activeElement)),
				intercepted: store.intercepts.length > gBefore,
				reachedBubble: gSpy.box.reached,
				defaultPrevented: g5Event.defaultPrevented,
			});
			outsideInput.remove();
			if (editor) editor.focus();
			await sleep(80);

			// G2：空白草稿（等价空草稿 steer 手势；真实派发）
			if (actions) actions.setDraft("   ");
			await frame();
			if (editor) editor.focus();
			gBefore = store.intercepts.length;
			const g2QueueBefore = (sessionOf().queue || []).length;
			gSpy = spyBubble("keydown", "g");
			dispatchKey(editor, {}, "g");
			await sleep(400);
			gSpy.stop();
			const g2QueueAfter = (sessionOf().queue || []).length;
			passRows.push({
				id: "G2", name: "空白草稿（空草稿 steer 手势）", mode: "真实派发",
				intercepted: store.intercepts.length > gBefore,
				reachedBubble: gSpy.box.reached,
				queueBefore: g2QueueBefore, queueAfter: g2QueueAfter,
			});
			if (actions) actions.setDraft("");
			await frame();

			// G3：/ 命令 —— 真实派发（用已注册的 /permission；popupSelect 型：只进入 claimed，不落任何副作用）
			if (actions) actions.setDraft("/goal 边界测试");
			await frame();
			if (editor) editor.focus();
			const g3Predicate = interceptKey(fakeEnter());
			const g3AccessBefore = (officialButtons().find((b) => String(b.getAttribute("aria-label")).includes("访问模式")) || {}).getAttribute
				? officialButtons().find((b) => String(b.getAttribute("aria-label")).includes("访问模式")).getAttribute("aria-label")
				: null;
			if (actions) actions.setDraft("/permission");
			await frame();
			if (editor) editor.focus();
			const g3CountBefore = store.intercepts.length;
			const g3Spy = spyBubble("keydown", "g3");
			const g3Event = dispatchKey(editor, {}, "g3");
			await sleep(600);
			g3Spy.stop();
			const g3Input = store.latest.input || {};
			const g3Claim = g3Input.claim && g3Input.claim.token ? String(g3Input.claim.token) : null;
			if (actions) actions.setDraft("");
			await frame();
			dispatchKey(editor, { key: "Escape", code: "Escape" }, "g3esc");
			await sleep(250);
			const g3AccessAfter = officialButtons().find((b) => String(b.getAttribute("aria-label")).includes("访问模式"));
			passRows.push({
				id: "G3", name: "/ 命令", mode: "真实派发（/permission，popupSelect 型）",
				predicate: g3Predicate,
				intercepted: store.intercepts.length > g3CountBefore,
				reachedBubble: g3Spy.box.reached,
				other: g3Spy.box.other,
				defaultPrevented: g3Event.defaultPrevented,
				phaseAfterDispatch: g3Input.phase || null,
				claimToken: g3Claim,
				officialEngaged: g3Claim === "/permission" || g3Input.phase === "claimed" || g3Input.phase === "submitting",
				accessUnchanged: g3AccessBefore === (g3AccessAfter ? g3AccessAfter.getAttribute("aria-label") : g3AccessBefore),
			});
			if (actions) actions.setDraft("");
			await frame();

			// G4：仅附件（草稿无文本 ⇒ 同一放行分支；真附件上传无法在探针内构造）
			if (editor) editor.focus();
			const g4Key = interceptKey(fakeEnter());
			const g4Click = wouldInterceptClick(sendButtonOf(cardOf(store.node)));
			passRows.push({
				id: "G4", name: "仅附件发送（草稿文本为空）", mode: "谓词级（判定只看草稿文本）",
				keyPredicate: g4Key, clickPredicate: g4Click,
			});

			// G6：fail-open（复用 E6 正控）+ 无重复 + 无卡死
			const e6 = steps.find((s) => s.id === "E6") || { observed: {} };
			const alive = {
				controlsAlive: Boolean(cardOf(store.node) && cardOf(store.node).querySelector('[data-dpo="controls"]')),
				tier: store.tier, armed: store.armed,
				editorFocusable: Boolean(editorOf(cardOf(store.node))),
				interceptCount: store.intercepts.length,
			};
			const rowsPass = passRows.filter((row) => row.mode === "真实派发").every((row) => row.intercepted === false && row.reachedBubble === true)
				&& g3Predicate === false && g4Key === false && g4Click === false;
			push("G", "放行白名单与 fail-open",
				"逐条复现放行清单（真实派发 + 谓词级）并核对 fail-open 正控",
				"五条放行项均不被接管且事件继续传播；未命中时官方链路照常发出（无重复、无卡死）",
				{
					passRows, alive,
					failOpen: { e6QueuedRowObserved: e6.observed.queuedRowObserved, e6RemovedCount: e6.observed.removedCount, e6StillInQueue: e6.observed.stillInQueue, e6QueuedText: e6.observed.queuedText },
				},
				rowsPass && alive.controlsAlive && alive.armed === true && Boolean(e6.observed.queuedRowObserved));

			// I1：查证 trace 在浮层里可见（小类 2.3 验收 3，渲染层机检）
			let tracePayload = null;
			try { tracePayload = await (await fetch(API + "/trace", { cache: "no-store" })).json(); } catch (e) { tracePayload = { error: String(e) }; }
			store.trace = tracePayload && tracePayload.ok ? tracePayload : null;
			setOverlay({ open: true, text: "查证 trace 渲染测试", src: "i1" });
			await frame();
			await sleep(150);
			const traceRowEls = document.querySelectorAll('[data-dpo="trace-row"]');
			const traceHostEl = document.querySelector('[data-dpo="trace"]');
			const i1pass = Boolean(tracePayload && tracePayload.ok)
				&& Array.isArray(tracePayload.normal) && tracePayload.normal.length > 0
				&& Boolean(traceHostEl) && traceRowEls.length > 0;
			push("I1", "查证动作在浮层可见",
				"拉取 /trace → 打开占位浮层 → 统计渲染出的 trace 行",
				"接口有数据且浮层内渲染出 ≥1 行查证动作（工具/参数/耗时/结果行数）",
				{
					apiOk: Boolean(tracePayload && tracePayload.ok),
					normalSteps: tracePayload && Array.isArray(tracePayload.normal) ? tracePayload.normal.length : null,
					cappedSteps: tracePayload && Array.isArray(tracePayload.capped) ? tracePayload.capped.length : null,
					converged: tracePayload ? tracePayload.converged : null,
					renderedRows: traceRowEls.length,
					hostPresent: Boolean(traceHostEl),
					sample: Array.from(traceRowEls).slice(0, 3).map((el) => String(el.textContent).slice(0, 60)),
				}, i1pass);
			setOverlay({ open: false });
			await frame();
			// J1：可拖动浮层（跟手 / 越界约束 / 点击穿透 / 关闭即清理）
			// 探针期间禁止把几何写进用户偏好，并在结束时还原（用户文件不被测试改写）
			const jUiSnapshot = { size: store.overlaySize ? Object.assign({}, store.overlaySize) : null, pos: store.overlayPos ? Object.assign({}, store.overlayPos) : null };
			store.suppressUiPersist = true;
			store.overlayPos = { x: 220, y: 140 };
			setOverlay({ open: true, text: "拖动测试文本", src: "j1" });
			await frame();
			await sleep(140);
			const jPanel = document.querySelector('[data-dpo="overlay"]');
			const jHead = jPanel ? jPanel.querySelector('[data-dpo="drag-handle"]') : null;
			const jLayer = jPanel ? jPanel.parentElement : null;
			const jRenderBefore = store.renderCount || 0;
			const jR0 = jPanel ? jPanel.getBoundingClientRect() : null;
			const jPt = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1, button: 0, clientX: x, clientY: y });
			if (jHead && jPanel) {
				const sx = jR0.left + Math.round(jR0.width / 2); const sy = jR0.top + 10;
				jHead.dispatchEvent(jPt("pointerdown", sx, sy));
				for (let i = 1; i <= 8; i += 1) jHead.dispatchEvent(jPt("pointermove", sx + 15 * i, sy + 10 * i));
				jHead.dispatchEvent(jPt("pointerup", sx + 120, sy + 80));
			}
			await frame();
			await sleep(90);
			const jR1 = jPanel ? jPanel.getBoundingClientRect() : null;
			const jFollow = jR0 && jR1 ? { dx: Math.round(jR1.left - jR0.left), dy: Math.round(jR1.top - jR0.top) } : null;
			const jRenders = (store.renderCount || 0) - jRenderBefore;
			if (jHead && jPanel) {
				const sx = jR1.left + Math.round(jR1.width / 2); const sy = jR1.top + 10;
				jHead.dispatchEvent(jPt("pointerdown", sx, sy));
				jHead.dispatchEvent(jPt("pointermove", sx + 5000, sy + 5000));
				jHead.dispatchEvent(jPt("pointerup", sx + 5000, sy + 5000));
			}
			await frame();
			await sleep(90);
			const jR2 = jPanel ? jPanel.getBoundingClientRect() : null;
			const jInView = Boolean(jR2) && jR2.left >= 0 && jR2.top >= 0 && jR2.right <= window.innerWidth + 1 && jR2.bottom <= window.innerHeight + 1;
			const jLayerPe = jLayer ? getComputedStyle(jLayer).pointerEvents : null;
			const jPanelPe = jPanel ? getComputedStyle(jPanel).pointerEvents : null;
			const jOutsideEl = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight - 60));
			const jOutsideOurs = Boolean(jOutsideEl && jOutsideEl.closest && jOutsideEl.closest('[data-dpo="overlay"]'));
			const jInsideEl = jR2 ? document.elementFromPoint(Math.round(jR2.left + 12), Math.round(jR2.top + 12)) : null;
			const jInsideOurs = Boolean(jInsideEl && jInsideEl.closest && jInsideEl.closest('[data-dpo="overlay"]'));
			// J1b：把"上一次在更大窗口里留下的视口外坐标"写回 → 重新开窗必须被夹回可见区（用户实测缺陷回归）
			store.overlayPos = { x: window.innerWidth + 4000, y: window.innerHeight + 4000 };
			setOverlay({ open: true });
			await frame();
			await sleep(150);
			const jPanel3 = document.querySelector('[data-dpo="overlay"]');
			const jR3 = jPanel3 ? jPanel3.getBoundingClientRect() : null;
			const jClampOnOpen = Boolean(jR3) && jR3.left >= 0 && jR3.top >= 0
				&& jR3.right <= window.innerWidth + 1 && jR3.bottom <= window.innerHeight + 1;
			const jClampObserved = jR3 ? { left: Math.round(jR3.left), top: Math.round(jR3.top), right: Math.round(jR3.right), bottom: Math.round(jR3.bottom) } : null;
			// J1c：右下角手柄拖拽改尺寸（变大/变小都验），且不得超过视口
			const jGrip = document.querySelector('[data-dpo="resize"]');
			let jResize = null;
			if (jGrip && jPanel3) {
				const r0 = jPanel3.getBoundingClientRect();
				const gx = r0.right - 6; const gy = r0.bottom - 6;
				jGrip.dispatchEvent(jPt("pointerdown", gx, gy));
				jGrip.dispatchEvent(jPt("pointermove", gx - 120, gy - 90));
				jGrip.dispatchEvent(jPt("pointerup", gx - 120, gy - 90));
				await frame();
				await sleep(140);
				const r1 = jPanel3.getBoundingClientRect();
				jResize = {
					w0: Math.round(r0.width), h0: Math.round(r0.height), w1: Math.round(r1.width), h1: Math.round(r1.height),
					dw: Math.round(r1.width - r0.width), dh: Math.round(r1.height - r0.height),
					persisted: store.overlaySize || null,
					withinViewport: r1.right <= window.innerWidth + 1 && r1.bottom <= window.innerHeight + 1,
				};
			}
			const jResizeOk = Boolean(jResize) && jResize.dw <= -100 && jResize.dw >= -140 && jResize.dh <= -70 && jResize.dh >= -110 && jResize.withinViewport === true;
			// J1d：点击守卫回归——在「回退」按钮上按下：不得 preventDefault（否则 click 被浏览器抑制）、不得启动拖动
			const jRollbackBtn = document.querySelector('[data-dpo="rollback"]');
			let jGuard = null;
			if (jRollbackBtn && jPanel3) {
				const bb = jRollbackBtn.getBoundingClientRect();
				const before = jPanel3.getBoundingClientRect();
				const downEv = jPt("pointerdown", bb.left + 4, bb.top + 4);
				jRollbackBtn.dispatchEvent(downEv);
				jRollbackBtn.dispatchEvent(jPt("pointermove", bb.left + 220, bb.top + 160));
				jRollbackBtn.dispatchEvent(jPt("pointerup", bb.left + 220, bb.top + 160));
				await frame();
				await sleep(90);
				const after = jPanel3.getBoundingClientRect();
				jGuard = {
					defaultPrevented: downEv.defaultPrevented === true,
					moved: Math.round(Math.abs(after.left - before.left) + Math.abs(after.top - before.top)),
					reachable: (() => { const el = document.elementFromPoint(Math.round(bb.left + 4), Math.round(bb.top + 4)); return Boolean(el && el.closest && el.closest('[data-dpo="rollback"]')); })(),
				};
			}
			const jGuardOk = Boolean(jGuard) && jGuard.defaultPrevented === false && jGuard.moved === 0 && jGuard.reachable === true;
			setOverlay({ open: false });
			// 几何还原：探针不改变用户的浮层尺寸/位置偏好
			store.suppressUiPersist = false;
			store.overlaySize = jUiSnapshot.size;
			store.overlayPos = jUiSnapshot.pos;
			await frame();
			await sleep(140);
			const jGone = !document.querySelector('[data-dpo="overlay"]');
			const jListeners = store.resizeListeners || 0;
			const jSendBtn = sendButtonOf(cardOf(store.node));
			let jSendReachable = null;
			if (jSendBtn) {
				const rb = jSendBtn.getBoundingClientRect();
				const el = document.elementFromPoint(Math.round(rb.left + rb.width / 2), Math.round(rb.top + rb.height / 2));
				jSendReachable = Boolean(el && (el === jSendBtn || (el.closest && el.closest("button") === jSendBtn)));
			}
			const j1pass = Boolean(jFollow) && Math.abs(jFollow.dx - 120) <= 6 && Math.abs(jFollow.dy - 80) <= 6
				&& jInView && jPanelPe === "auto" && !jOutsideOurs && jInsideOurs && jSendReachable === true
				&& jGone && jListeners === 0 && jRenders <= 2
				&& jClampOnOpen === true && jResizeOk === true && jGuardOk === true;
			push("J1", "可拖动浮层（跟手/边界/穿透/清理/开窗夹紧/改尺寸）",
				"合成 pointerdown→move×8→up 位移(+120,+80)；再拖 +5000；elementFromPoint 验穿透；写回视口外旧坐标后重开；右下角手柄拖拽改尺寸；关闭后查 DOM 与监听计数",
				"位移与手势 1:1（±6px）、面板始终在视口内、容器穿透/面板可点、视口外旧坐标重开后仍在可见区、右下角可改尺寸且不越界、关闭后节点与监听均清理、拖动期间 React 渲染 ≤2",
				{
					follow: jFollow, inView: jInView, layerPointerEvents: jLayerPe, panelPointerEvents: jPanelPe, sendReachable: jSendReachable,
					outsideHitsOurs: jOutsideOurs, insideHitsOurs: jInsideOurs, closedRemoved: jGone,
					resizeListenersAfterClose: jListeners, rendersDuringDrag: jRenders,
					clampOnOpen: jClampOnOpen, clampObserved: jClampObserved, resize: jResize, resizeOk: jResizeOk, clickGuard: jGuard, guardOk: jGuardOk,
					rectAfterClamp: jR2 ? { left: Math.round(jR2.left), top: Math.round(jR2.top), right: Math.round(jR2.right), bottom: Math.round(jR2.bottom) } : null,
					viewport: { w: window.innerWidth, h: window.innerHeight },
				}, j1pass);
			// K1：流式思考与产出（分区 / 增量 / 首字 / 失败态 / 重试）
			const kReq = "把那个页面弄好看点，动画也加上";
			const kT0 = Date.now();
			startRun(kReq, "basic", false);
			await frame();
			let kFirst = null;
			for (let i = 0; i < 60 && kFirst === null; i += 1) {
				await sleep(100);
				const r = store.run;
				if (r && (r.reasoning.length > 0 || r.text.length > 0)) kFirst = Date.now() - kT0;
			}
			const kPaneREarly = Boolean(document.querySelector('[data-dpo="pane-reasoning"]'));
			const kPaneTEarly = Boolean(document.querySelector('[data-dpo="pane-text"]'));
			const kSnap1 = { r: store.run.reasoning.length, t: store.run.text.length };
			await sleep(2500);
			const kSnap2 = { r: store.run.reasoning.length, t: store.run.text.length };
			for (let i = 0; i < 160 && store.run.status === "running"; i += 1) await sleep(250);
			const kRun = store.run;
			const kReason = kRun.reasoning || "";
			const kText = kRun.text || "";
			const kPaneR = document.querySelector('[data-dpo="pane-reasoning"]');
			const kPaneT = document.querySelector('[data-dpo="pane-text"]');
			// 通道身份判据：两栏渲染内容必须分别对应各自事件流的累积（思考通道可能引用结构标题，不能拿标题当判据）
			const kPaneRText = kPaneR ? String(kPaneR.textContent || "") : "";
			const kPaneTText = kPaneT ? String(kPaneT.textContent || "") : "";
			const kRSample = kReason.slice(0, 40);
			const kTSample = kText.slice(0, 40);
			const kSeparated = Boolean(kPaneR && kPaneT)
				&& kPaneR !== kPaneT
				&& kPaneRText !== kPaneTText
				&& (kRSample.length === 0 || kPaneRText.indexOf(kRSample) >= 0)
				&& (kTSample.length === 0 || kPaneTText.indexOf(kTSample) >= 0)
				&& (kReason.length === 0 || kText.length === 0 || kPaneRText.indexOf(kTSample) < 0);
			// 失败态：真实失败路径（未注册 provider）
			startRun(kReq, "basic", true);
			await frame();
			for (let i = 0; i < 100 && store.run.status !== "error" && store.run.status !== "done"; i += 1) await sleep(200);
			const kErrNode = document.querySelector('[data-dpo="run-error"]');
			const kRetryBtn = document.querySelector('[data-dpo="retry"]');
			const kFail = {
				status: store.run.status,
				error: String(store.run.error || "").slice(0, 160),
				errorNodeText: kErrNode ? String(kErrNode.textContent).slice(0, 160) : null,
				hasRetry: Boolean(kRetryBtn),
				textEmpty: (store.run.text || "").length === 0,
			};
			let kRecovered = false;
			if (kRetryBtn) {
				dispatchClick(kRetryBtn, "k1retry");
				for (let i = 0; i < 160 && (store.run.status === "running" || (store.run.text || "").length === 0); i += 1) await sleep(250);
				kRecovered = store.run.status === "done" && (store.run.text || "").length > 0 && !store.run.error;
			}
			const k1pass = kFirst !== null && kFirst <= 2000 && kPaneREarly && kPaneTEarly
				&& (kSnap2.r + kSnap2.t) > (kSnap1.r + kSnap1.t) && kSeparated
				&& kFail.status === "error" && kFail.error.length > 0 && kFail.hasRetry && kFail.textEmpty
				&& kRecovered === true;
			push("K1", "流式思考与产出（分区/增量/首字/失败态/重试）",
				"真实启动一次优化并采样两栏字数；再用未注册 provider 触发真实失败并点重试",
				"两栏独立且不混、字数持续增长、首字 ≤2s（不白屏）、失败有可读原因+重试且产出栏为空、重试后恢复出字",
				{
					firstPaintMs: kFirst, panesEarly: { reasoning: kPaneREarly, text: kPaneTEarly },
					snap1: kSnap1, snap2: kSnap2, separated: kSeparated,
					runStatus: kRun.status, textChars: kText.length, reasoningChars: kReason.length,
					fail: kFail, recovered: kRecovered,
				}, k1pass);
			// L1：审查态与双按钮（可编辑 / 超长可滚 / 同色系 / 红色 / 提交链路）
			const lArea0 = document.querySelector('[data-dpo="review-text"]');
			const lConfirm = document.querySelector('[data-dpo="confirm"]');
			const lRegen = document.querySelector('[data-dpo="regen"]');
			const lLong = "DPO-编辑后-" + "段落内容".repeat(140);
			if (lArea0) {
				const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
				setter.call(lArea0, lLong);
				lArea0.dispatchEvent(new Event("input", { bubbles: true }));
			}
			await frame();
			await sleep(150);
			const lArea = document.querySelector('[data-dpo="review-text"]');
			const lEdited = Boolean(store.reviewText === lLong);
			const lScroll = lArea ? { scrollH: lArea.scrollHeight, clientH: lArea.clientHeight, overflowY: getComputedStyle(lArea).overflowY } : null;
			const lScrollable = Boolean(lScroll) && lScroll.scrollH > lScroll.clientH && (lScroll.overflowY === "auto" || lScroll.overflowY === "scroll");
			const rgbOf = (s) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(s || "")); return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : null; };
			const lSendBtn = sendButtonOf(cardOf(store.node));
			const lSendBg = lSendBtn ? getComputedStyle(lSendBtn).backgroundColor : null;
			const lConfirmBg = lConfirm ? getComputedStyle(lConfirm).backgroundColor : null;
			const lRegenBg = lRegen ? getComputedStyle(lRegen).backgroundColor : null;
			const lRegenRgb = rgbOf(lRegenBg);
			const lRegenIsRed = Boolean(lRegenRgb) && lRegenRgb.r > 140 && lRegenRgb.g < 120 && lRegenRgb.b < 120;
			const lSameAccent = Boolean(lSendBg && lConfirmBg && lSendBg === lConfirmBg);
			const lDraftBefore = draftLive();
			try { await post("/watch/clear", {}); } catch (e) { /* noop（清看门狗以便观测本条，收尾 sweep 会重新挂回） */ }
			const lRunning = runningNow();
			if (lConfirm && lRunning) dispatchClick(lConfirm, "l1confirm");
			if (!lRunning) { push("L1", "审查态与双按钮", "会话 idle：跳过破坏性提交（避免消息永久落库）", "仅验证可编辑/可滚/配色", { skippedSubmit: true, edited: lEdited, scrollable: lScrollable, sameAccent: lSameAccent, regenIsRed: lRegenIsRed }, lEdited && lScrollable && lSameAccent && lRegenIsRed); }
			await frame();
			await sleep(350);
			const lDraftAfter = draftLive();
			let lQueuedRow = null;
			for (let i = 0; i < 14 && !lQueuedRow; i += 1) {
				await sleep(300);
				lQueuedRow = (sessionOf().queue || []).find((r) => String(r.text || "").includes("DPO-编辑后-")) || null;
			}
			let lRemoved = null;
			try { lRemoved = await post("/queued/remove-by-text", { match: "DPO-编辑后-" }); } catch (e) { lRemoved = { error: String(e) }; }
			const lRemovedCount = lRemoved && Array.isArray(lRemoved.removed) ? lRemoved.removed.length : 0;
			const lReviewGone = !document.querySelector('[data-dpo="review"]');
			const l1pass = Boolean(lArea0 && lConfirm && lRegen) && lEdited && lScrollable && lRegenIsRed && lSameAccent
				&& lDraftAfter === "" && lRemovedCount > 0 && lReviewGone;
			push("L1", "审查态与双按钮（可编辑/可滚/配色/提交链路）",
				"写入超长编辑文本→派发 input；取官方发送按钮与『确认提交』计算色；点确认提交→查输入框与官方待处理队列→宿主撤销",
				"编辑值被采纳、超长可滚、确认提交与发送按钮同色、重新生成为红、提交后输入框清空且文本进入官方队列（零污染）",
				{
					hasTextarea: Boolean(lArea0), hasConfirm: Boolean(lConfirm), hasRegen: Boolean(lRegen),
					edited: lEdited, scroll: lScroll, scrollable: lScrollable,
					sendBg: lSendBg, confirmBg: lConfirmBg, sameAccent: lSameAccent,
					regenBg: lRegenBg, regenIsRed: lRegenIsRed,
					draftBeforeLen: String(lDraftBefore || "").length, draftAfterLen: String(lDraftAfter || "").length,
					queuedRow: Boolean(lQueuedRow), queuedText: lQueuedRow ? String(lQueuedRow.text).slice(0, 40) : null,
					removedCount: lRemovedCount, reviewClosed: lReviewGone,
				}, l1pass);
			// M1：回退二次确认（确认行 / 取消不丢状态 / 确定=停+关+不发+原文保持 / 无残留 / 不串台）
			const mOrig = "DPO-原文保持-" + token;
			if (actions) actions.setDraft(mOrig);
			await frame();
			startRun("把那个页面弄好看点，动画也加上", "basic", false);
			for (let i = 0; i < 60 && (store.run.status === "connecting" || (store.run.text || "").length === 0 && (store.run.reasoning || "").length === 0); i += 1) await sleep(200);
			const mRunningBefore = store.run ? store.run.status : null;
			const mRbBtn = document.querySelector('[data-dpo="rollback"]');
			if (mRbBtn) dispatchClick(mRbBtn, "m1rb");
			await frame();
			await sleep(120);
			const mConfirmShown = Boolean(document.querySelector('[data-dpo="rollback-confirm"]'));
			const mStateKeptOnPrompt = store.run ? store.run.status : null;
			const mNoBtn = document.querySelector('[data-dpo="rollback-no"]');
			if (mNoBtn) dispatchClick(mNoBtn, "m1no");
			await frame();
			await sleep(120);
			const mConfirmGone = !document.querySelector('[data-dpo="rollback-confirm"]');
			const mStateKeptAfterCancel = store.run ? store.run.status : null;
			// 再点回退 → 确定
			const mRbBtn2 = document.querySelector('[data-dpo="rollback"]');
			if (mRbBtn2) dispatchClick(mRbBtn2, "m1rb2");
			await frame();
			await sleep(120);
			const mYesBtn = document.querySelector('[data-dpo="rollback-yes"]');
			const mRunIdBefore = store.run ? store.run.runId : null;
			if (mYesBtn) dispatchClick(mYesBtn, "m1yes");
			await frame();
			await sleep(800);
			const mOverlayGone = !document.querySelector('[data-dpo="overlay"]');
			const mRunCleared = store.run === null;
			const mDraftKept = draftLive() === mOrig;
			let mRuns = null;
			try { mRuns = await (await fetch(API + "/runs", { cache: "no-store" })).json(); } catch (e) { mRuns = { error: String(e) }; }
			const mTarget = mRuns && Array.isArray(mRuns.runs) ? mRuns.runs.find((r) => r.id === mRunIdBefore) : null;
			const mNoResidue = Boolean(mTarget) && mTarget.status === "aborted" && mTarget.subs === 0;
			// 不串台：回退后再起一次，应能正常跑完
			startRun("把那个页面弄好看点", "basic", false);
			for (let i = 0; i < 160 && store.run && store.run.status !== "done" && store.run.status !== "error"; i += 1) await sleep(250);
			const mNextOk = Boolean(store.run) && store.run.status === "done" && (store.run.text || "").length > 0;
			const m1pass = Boolean(mRbBtn && mYesBtn) && mConfirmShown && mStateKeptOnPrompt === mRunningBefore
				&& mConfirmGone && (mStateKeptAfterCancel === "running" || mStateKeptAfterCancel === mRunningBefore)
				&& mOverlayGone && mRunCleared && mDraftKept && mNoResidue && mNextOk;
			push("M1", "回退二次确认（确认/取消/中止/原文保持/不串台）",
				"起一次优化→点回退看确认行→取消（状态应不丢）→再点回退并确定→查宿主 /runs 与输入框→再起一次验证不串台",
				"确认行出现、取消后状态不丢、确定后浮层关闭+run 中止且 subs=0+原文逐字保持+不发消息、随后再次优化能正常完成",
				{
					runningBefore: mRunningBefore, confirmShown: mConfirmShown, stateKeptOnPrompt: mStateKeptOnPrompt,
					confirmGoneAfterCancel: mConfirmGone, stateAfterCancel: mStateKeptAfterCancel,
					overlayClosed: mOverlayGone, runCleared: mRunCleared, draftKept: mDraftKept,
					abortedRun: mTarget, noResidue: mNoResidue, nextRunOk: mNextOk,
					nextRunChars: store.run ? (store.run.text || "").length : 0,
				}, m1pass);
			store.rollbackConfirm = false;
			setOverlay({ open: false });
			store.run = null;
			if (actions) actions.setDraft("");
			// N1：优化模型弹层（同源目录 / 独立于对话模型 / 下一次优化生效）
			let nCat = null;
			try { nCat = await (await fetch(API + "/models", { cache: "no-store" })).json(); } catch (e) { nCat = { error: String(e) }; }
			store.modelCatalog = nCat && nCat.ok ? nCat : null;
			const nCard = cardOf(store.node);
			const nSeat = buttonsOf(nCard).find((b) => String(b.getAttribute("aria-label")).includes("选择模型"));
			const nSeatBefore = nSeat ? nSeat.getAttribute("aria-label") : null;
			const nGroups = nCat && Array.isArray(nCat.groups) ? nCat.groups : [];
			const nSeatName = nSeatBefore ? (nSeatBefore.match(/当前\s*([^，,]+)/) || [])[1] : null;
			const nNameMatched = Boolean(nSeatName) && nGroups.some((g) => (g.models || []).some((m) => m.name === nSeatName || m.id === nSeatName));
			const nPill = nCard ? nCard.querySelector('[data-dpo="model"]') : null;
			if (nPill) dispatchClick(nPill, "n1open");
			await frame();
			await sleep(180);
			const nPop = document.querySelector('[data-dpo="model-pop"]');
			const nItems = [...document.querySelectorAll('[data-dpo="model-item"]')];
			const nTitles = [...document.querySelectorAll('[data-dpo="model-group-name"]')].map((el) => String(el.textContent));
			const curSel = nCat && nCat.current ? nCat.current : null;
			let nPick = null;
			for (const el of nItems) {
				const p = el.getAttribute("data-provider");
				const m = el.getAttribute("data-model");
				if (!curSel || p !== curSel.provider || m !== curSel.model) { nPick = { provider: p, model: m, name: String(el.textContent) }; break; }
			}
			if (nPick) {
				const target = nItems.find((el) => el.getAttribute("data-provider") === nPick.provider && el.getAttribute("data-model") === nPick.model);
				if (target) dispatchClick(target, "n1pick");
			}
			await frame();
			await sleep(180);
			const nSel = store.modelSel;
			const nSeatAfter = nSeat ? nSeat.getAttribute("aria-label") : null;
			const nPopClosed = !document.querySelector('[data-dpo="model-pop"]');
			let nRunSel = null;
			if (nSel) {
				startRun("把那个页面弄好看点", "basic", false);
				for (let i = 0; i < 40 && !(store.run && store.run.runId); i += 1) await sleep(200);
				await sleep(1200);
				try {
					const rr = await (await fetch(API + "/runs", { cache: "no-store" })).json();
					const mine = rr && Array.isArray(rr.runs) ? rr.runs.find((x) => x.id === (store.run ? store.run.runId : null)) : null;
					nRunSel = mine ? { provider: mine.provider, model: mine.model } : null;
				} catch (e) { nRunSel = { error: String(e) }; }
				if (store.run && store.run.runId) { try { await post("/run/abort", { runId: store.run.runId }); } catch (e) { /* noop */ } }
				store.run = null;
				setOverlay({ open: false });
			}
			const n1pass = Boolean(nPop) && nItems.length > 0 && nGroups.length > 0 && nNameMatched
				&& nTitles.length === nGroups.length && Boolean(nSel) && nSeatAfter === nSeatBefore && nPopClosed
				&& Boolean(nRunSel) && nRunSel.provider === nSel.provider && nRunSel.model === nSel.model;
			push("N1", "优化模型弹层（同源/独立/生效）",
				"拉 /models 与官方座位 aria-label 交叉核对；点胶囊开弹层→选一个不同的模型→查官方座位是否变→再跑一次优化查 /runs 实际模型",
				"弹层分组数=目录分组数且模型名与官方座位同源；选择只影响优化（官方座位 aria-label 一字不变）；下一次运行 provider/model == 新选择",
				{
					catalogGroups: nGroups.length, catalogModels: nGroups.reduce((a, g) => a + (g.models || []).length, 0),
					seatLabelBefore: nSeatBefore, seatModelName: nSeatName, nameMatched: nNameMatched,
					popShown: Boolean(nPop), items: nItems.length, groupTitles: nTitles.slice(0, 4),
					picked: nPick, selection: nSel, seatLabelAfter: nSeatAfter, seatUnchanged: nSeatAfter === nSeatBefore,
					popClosed: nPopClosed, runUsed: nRunSel,
				}, n1pass);
			store.modelSel = null;
			emit();
			// P1：落盘与兜底（不可用模型提示 / 一键回默认 / 双客户端一致）
			const pA = await (await fetch(API + "/state", { cache: "no-store" })).json();
			const pB = await (await fetch(API + "/state", { cache: "no-store" })).json();
			const pConsistent = JSON.stringify(pA.state) === JSON.stringify(pB.state);
			store.modelSel = { provider: "ollama", model: "qwen3:8b", name: "qwen3:8b（本地）" };
			persistState();
			startRun("落盘兜底测试：把那个页面弄好看点", "basic", false);
			for (let i = 0; i < 100 && store.run && store.run.status !== "error" && store.run.status !== "done"; i += 1) await sleep(250);
			await frame();
			await sleep(150);
			const pErr = document.querySelector('[data-dpo="run-error"]');
			const pReset = document.querySelector('[data-dpo="reset-model"]');
			const pFail = { status: store.run ? store.run.status : null, msg: pErr ? String(pErr.textContent).slice(0, 110) : null, hasReset: Boolean(pReset) };
			let pRecovered = false;
			if (pReset) {
				dispatchClick(pReset, "p1reset");
				for (let i = 0; i < 140 && store.run && (store.run.status === "running" || store.run.status === "connecting"); i += 1) await sleep(250);
				pRecovered = Boolean(store.run) && store.run.status === "done" && (store.run.text || "").length > 0 && !store.modelSel;
			}
			const pAfter = await (await fetch(API + "/state", { cache: "no-store" })).json();
			if (store.run && store.run.runId) { try { await post("/run/abort", { runId: store.run.runId }); } catch (e) { /* noop */ } }
			const p1pass = pConsistent && pFail.status === "error" && Boolean(pFail.msg) && pFail.hasReset
				&& pRecovered === true && pAfter.state.model === null;
			push("P1", "落盘与兜底（提示/一键回默认/一致性）",
				"选一个真实不可用的模型（ollama 本机未启动）起跑→看错误提示与恢复按钮→点『恢复默认模型并重试』→查是否用回默认且落盘清空；并两次读 /state 比对",
				"失败有可读原因、有『恢复默认』入口、点击后回到默认模型并成功出字、落盘 model=null、两次读取一致",
				{
					consistent: pConsistent, before: { tier: pA.state.tier, permission: pA.state.permission, model: pA.state.model }, fail: pFail,
					recovered: pRecovered, after: { tier: pAfter.state.tier, permission: pAfter.state.permission, model: pAfter.state.model, revision: pAfter.state.revision },
					finalChars: store.run ? (store.run.text || "").length : 0,
				}, p1pass);
			store.run = null;
			setOverlay({ open: false });
			// H1：真·A/B 基线 —— 拆净本插件全部监听后，同一手势应原样进入官方链路
			const baselineMarker = "DPO-基线测试-" + token;
			const h1BeforeQueue = (sessionOf().queue || []).length;
			let h1Baseline = { executed: false };
			let h1Removed = null;
			let h1Restored = false;
			try {
				if (typeof window.__DPO_DISPOSE__ === "function") window.__DPO_DISPOSE__();
				await sleep(250);
				if (actions) actions.setDraft(baselineMarker);
				await frame();
				if (editor) editor.focus();
				// H1 基线用"当前页面上的活编辑器"重新解析（拆净插件后旧引用可能已脱离文档）
				const liveEditor = document.querySelector('[contenteditable="true"]');
				if (liveEditor) liveEditor.focus();
				const h1CountBefore = store.intercepts.length;
				dispatchKey(liveEditor || editor, {}, "h1");
				let h1Row = null;
				for (let i = 0; i < 12 && h1Row === null; i += 1) {
					await sleep(300);
					h1Row = (sessionOf().queue || []).find((r) => String(r.text || "").includes(baselineMarker)) || null;
				}
				h1Baseline = {
					executed: true,
					interceptedWhileDisposed: store.intercepts.length > h1CountBefore,
					queueBefore: h1BeforeQueue,
					queuedRow: Boolean(h1Row),
					queuedText: h1Row ? String(h1Row.text).slice(0, 50) : null,
					controlsNodeGone: !(store.node && store.node.isConnected),
				};
				try { h1Removed = await post("/queued/remove-by-text", { match: baselineMarker }); } catch (e) { h1Removed = { error: String(e) }; }
			} catch (e) {
				h1Baseline = { executed: false, error: String(e) };
			} finally {
				try { exports.apply(ctx); } catch (e) { /* 恢复失败在下一步断言里体现 */ }
				await sleep(400);
				const back = cardOf(store.node);
				h1Restored = Boolean(back && back.querySelector('[data-dpo="tier"]'));
			}
			push("H1", "真·A/B 基线（插件拆净）",
				"调用自身 dispose 移除全部监听与 UI → 派发同一 Enter → 宿主权威核对官方队列 → 撤销 → 重新装载",
				"无监听时同一手势原样进入官方待处理队列；撤销成功；重新装载后三控件回到原位",
				{
					baseline: h1Baseline, removed: h1Removed, restored: h1Restored,
					removedCount: h1Removed && Array.isArray(h1Removed.removed) ? h1Removed.removed.length : 0,
					note: "拆净后客户端快照不再刷新，故以宿主权威撤销结果为准（queuedRow 字段仅作参考）",
				},
				h1Baseline.interceptedWhileDisposed === false
					&& Boolean(h1Removed && Array.isArray(h1Removed.removed) && h1Removed.removed.length > 0)
					&& h1Restored === true);

			const windowEnd = Date.now();
			// 自清场：把本探针可能在官方队列里留下的标记项全部撤掉（宿主侧权威扫描）
			let sweep = null;
			try { sweep = await post("/inbox/sweep", {}); } catch (e) { sweep = { error: String(e) }; }
			if (actions) {
				if (actions) actions.setDraft(initialDraft || "");
				await frame();
			}
			const report = {
				plugin: NS, token, kind: "selftest",
				sessionId: String(store.latest.sessionId || ""),
				windowStart, windowEnd,
				userAgent: String(navigator.userAgent || ""),
				env: { sendLabels: [...SEND_LABELS], interceptCount: store.intercepts.length, intercepts: store.intercepts.slice(-8) },
				steps,
				sweep,
				passed: steps.filter((s) => s.pass).length,
				total: steps.length,
			};
			releaseProbeArtifacts();
			// 收尾还原用户配置（档位/权限/浮层几何）——探针绝不能留下"档位被关掉"这类副作用
			const snap = store.probeUiSnapshot;
			if (snap) {
				if (snap.tier && snap.tier !== store.tier) setTier(snap.tier, "probe-restore");
				if (snap.permission && snap.permission !== store.permission) setPermission(snap.permission, "probe-restore");
				store.overlaySize = snap.size || null;
				store.overlayPos = snap.pos || null;
				setOverlay({ open: false });
				beacon("probe-restored", { tier: store.tier, permission: store.permission, size: store.overlaySize });
			}
			window.__DPO_PROBE_RUNNING__ = false;
			const res = await post("/report", report);
			store.lastReport = { ok: Boolean(res && res.ok), file: res && res.file, userMessageCount: res && res.userMessageCount };
			emit();
			return report;
		}

		/* ══════════ 插件体 ══════════ */
		exports.inject = ["slots", "locale"];

		exports.apply = function apply(ctx) {
			// HMR/重复 apply：新实例接管前先拆掉旧实例全部副作用（防双轮询 → 双探针 → 队列残留）
			const previousToken = (() => { try { return window.__DPO_ACTIVE__ || null; } catch (e) { return null; } })();
			try { if (typeof window.__DPO_DISPOSE__ === "function") window.__DPO_DISPOSE__(); } catch (e) { /* noop */ }
			// 抢注单例 token：此后旧实例的拦截与渲染一律作废（旧实例"后台跑、无 UI"的根因）
			try { window.__DPO_ACTIVE__ = INSTANCE_TOKEN; } catch (e) { /* noop */ }
			const ownDisposers = [];
			const own = (register, label) => {
				const dispose = ctx.effect(register, label);
				ownDisposers.push(typeof dispose === "function" ? dispose : () => {});
			};
			window.__DPO_DISPOSE__ = () => {
				for (const d of ownDisposers) { try { d(); } catch (e) { /* noop */ } }
				ownDisposers.length = 0;
				window.__DPO_PROBE_RUNNING__ = false;
			};
			localeService = ctx.locale;
			if (localeService && typeof localeService.subscribe === "function") {
				own(() => localeService.subscribe(() => { loadSendLabels(); beacon("labels", { labels: [...SEND_LABELS] }); }), NS + ": locale watch");
			}
			const labels = loadSendLabels();
			ctx.logger?.info?.("[" + NS + "] send labels = " + JSON.stringify(labels));
			fetch(API + "/state", { cache: "no-store" }).then((r) => r.json()).then((d) => {
				const st = d && d.ok ? d.state : null;
				if (!st) return;
				// 几何（尺寸/位置）无论用户是否刚改过档位都恢复——它不影响拦截语义
				if (st.ui) {
					const w = typeof st.ui.w === "number" ? st.ui.w : null;
					const h = typeof st.ui.h === "number" ? st.ui.h : null;
					if (w || h) store.overlaySize = clampSize(w || 520, h || null);
					if (typeof st.ui.x === "number" && typeof st.ui.y === "number") store.overlayPos = { x: st.ui.x, y: st.ui.y };
					beacon("ui-restored", { size: store.overlaySize || null, pos: store.overlayPos || null });
				}
				// 按会话的档位/权限：先装入表（无论用户是否刚改过，都要装上）
				if (st.perSession && typeof st.perSession === "object") {
					for (const k of Object.keys(st.perSession)) {
						const v = st.perSession[k] || {};
						if (typeof v.tier === "string") store.tierBySession[k] = v.tier;
						if (typeof v.permission === "string") store.permissionBySession[k] = v.permission;
					}
					beacon("per-session-restored", { sessions: Object.keys(st.perSession).length, current: store.viewSessionId || null });
				}
				// 若用户在请求返回前已手动改过档位/权限，绝不让迟到的落盘值回写覆盖
				if (store.touched === true) { beacon("state-skip-stale", { tier: store.tier, permission: store.permission }); emit(); return; }
				if (st.tier && st.tier !== store.tier) setTier(st.tier, "init");
				if (st.permission && st.permission !== store.permission) setPermission(st.permission, "init");
				// 表里有当前会话的值 → 以它为准（覆盖全局默认）
				applyTierPermissionFor(store.viewSessionId);
				store.modelSel = st.model ? { provider: st.model.provider, model: st.model.model, name: st.model.name || st.model.model } : null;
				beacon("state-loaded", { tier: store.tier, permission: store.permission, model: st.model ? st.model.provider + "/" + st.model.model : null, revision: st.revision, perSessionHit: Boolean(st.perSession && st.perSession[store.viewSessionId || ""]) });
				emit();
			}).catch(() => {});
			beacon("apply", { build: "v47-singleton", token: INSTANCE_TOKEN, previousToken, hasBoundary: String(OverlayBoundary).indexOf("getDerivedStateFromError") >= 0, hasGrip: String(Overlay).indexOf("dpo-size-grip") >= 0 });
			// 目录预热：开弹层时无需等待（首次打开即已是本地数据）
			window.setTimeout(() => { try { if (isActiveInstance()) void loadCatalog("apply", false); } catch (e) { /* noop */ } }, 600);
			// 样式落地自检：读真实注入的样式表，确认"更大默认尺寸 + 内层滚动 + 改尺寸手柄"确实生效
			window.setTimeout(() => {
				try {
					const rules = [];
					for (const sheet of Array.from(document.styleSheets)) {
						try { for (const r of Array.from(sheet.cssRules || [])) rules.push(r.cssText || ""); } catch (e) { /* 跨域表 */ }
					}
					const blob = rules.join("\n").replace(/\s+/g, ""); // 浏览器会规范化 cssText（冒号后补空格），去空白后比较
					const has = (needle) => blob.indexOf(needle) >= 0;
					beacon("css-probe", {
						rules: rules.length,
						bigger: has("max-height:min(78vh,660px)") && has("width:520px"),
						innerScroll: has(".dpo-overlay-scroll") && has("flex:11auto"),
						overflowY: has("overflow-y:auto"),
						grip: has(".dpo-size-grip") && has("cursor:nwse-resize"),
						stickyReview: has(".dpo-review.dpo-overlay-actions") && has("bottom:0"),
						regenStyles: has(".dpo-regen-input"),
						// v51 精致化视觉层
						polish: has("@keyframesdpo-pop-in") && has("@keyframesdpo-ov-rise") && has("@keyframesdpo-pulse") && has("@keyframesdpo-tick") && has("@keyframesdpo-shimmer"),
						glass: has("backdrop-filter:blur(16px)"),
						accMix: has("--dpo-acc:var(--dsw-alias-state-business-primary"),
						stateDot: has(".dpo-overlay[data-state=\"running\"]"),
						liveCaret: has(".dpo-pane[data-live=\"true\"]"),
						selHighlight: has(".dpo-pop-item[data-selected=\"true\"]"),
						reduceMotion: has("prefers-reduced-motion:reduce"),
						// v52 舒适层
						comfort: has("flex:01148px") && has("min-width:124px") && has("--dpo-fs-2:13px") && has("width:308px") && has("max-height:132px") && has("min-height:150px"),
					});
				} catch (e) { beacon("css-probe", { error: String(e) }); }
			}, 400);

			// 捕获阶段拦截：注册在 window 上，早于 React 根容器与编辑器自身处理器
			own(() => {
				let staleBeacons = 0;
				const stale = (how) => {
					if (staleBeacons < 3) { staleBeacons += 1; beacon("stale-instance-ignored", { how, token: INSTANCE_TOKEN, active: String(window.__DPO_ACTIVE__ || "").slice(-12) }); }
					return true;
				};
				const onFocus = (e) => {
					const card = cardOf(store.node);
					lastFocusInComposer = Boolean(card && e.target && card.contains(e.target));
				};
				const onKey = (e) => {
					if (!isActiveInstance()) return stale("keydown");
					if (e.key !== "Enter") {
						const now = Date.now();
						if (now - lastKeyBeacon > 800) {
							lastKeyBeacon = now;
							beacon("keydown-any", {
								key: e.key, trusted: e.isTrusted === true,
								draftHookLen: draftFromHook().length,
								draftDomLen: draftFromDom() === null ? null : draftFromDom().length,
								inside: insideComposer(),
							});
						}
						return;
					}
					const verdict = interceptKey(e);
					beacon("keydown-enter", {
						verdict,
						trusted: e.isTrusted === true,
						isComposing: e.isComposing === true,
						keyCode: e.keyCode,
						shift: e.shiftKey,
						armed: store.armed,
						card: Boolean(cardOf(store.node)),
						inside: insideComposer(),
						lastFocusInComposer,
						activeTag: document.activeElement ? document.activeElement.tagName : null,
						activeCE: document.activeElement ? document.activeElement.isContentEditable === true : null,
						draftLen: draftLive().length,
						draftHookLen: draftFromHook().length,
						draftDomLen: draftFromDom() === null ? null : draftFromDom().length,
					});
					if (!verdict) return;
					e.preventDefault();
					e.stopPropagation();
					const row = record("keydown-enter", draftLive());
					interceptAndOptimize(row.text);
				};
				const onClick = (e) => {
					if (!isActiveInstance()) return stale("click");
					const btn = e.target && e.target.closest ? e.target.closest("button") : null;
					if (!btn) return;
					const card = cardOf(store.node);
					if (!card || !card.contains(btn)) return;
					const verdict = interceptClick(e);
					const label = btn.getAttribute("aria-label");
					beacon("click-button", {
						verdict, label, isLast: lastButtonOf(card) === btn,
						byLabel: isSendLabel(label), labels: [...SEND_LABELS], armed: store.armed,
					});
					if (!verdict) return;
					e.preventDefault();
					e.stopPropagation();
					const row = record("click-send", draftLive(), { label });
					interceptAndOptimize(row.text);
				};
				document.addEventListener("focusin", onFocus, true);
				document.addEventListener("focusout", onFocus, true);
				window.addEventListener("keydown", onKey, true);
				window.addEventListener("click", onClick, true);
				return () => {
					document.removeEventListener("focusin", onFocus, true);
					document.removeEventListener("focusout", onFocus, true);
					window.removeEventListener("keydown", onKey, true);
					window.removeEventListener("click", onClick, true);
				};
			}, NS + ": capture listeners");

			// 样式（随插件卸载移除）
			own(() => {
				const style = document.createElement("style");
				style.setAttribute("data-plugin", NS);
				style.textContent = [
					
					
					
					
					
					
					
					".dpo-controls{display:flex;align-items:center;gap:8px;flex:0 1 auto;min-width:0}",
					".dpo-slider{display:inline-flex;align-items:center;gap:6px;height:24px;flex:0 1 auto;min-width:0}",
					".dpo-slider[data-disabled=\"true\"]{opacity:.45}",
					".dpo-slider-track{position:relative;display:flex;flex:0 1 68px;min-width:36px;height:16px;touch-action:none;cursor:pointer;align-items:center}",
					".dpo-slider-track::before{content:\"\";position:absolute;left:0;right:0;top:6px;height:4px;background:var(--dsw-alias-border-l1,#4a4a4a);border-radius:2px}",
					".dpo-slider-fill{position:absolute;left:0;top:6px;height:4px;background:var(--dsw-alias-state-business-primary,#4a9eff);border-radius:2px;pointer-events:none;transition:width .18s cubic-bezier(.4,0,.2,1)}",
					".dpo-slider-thumb{position:absolute;top:2px;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4a9eff);box-shadow:0 0 0 2px var(--dsw-specific-tip,#1b1b1b),0 1px 4px rgba(0,0,0,.45);pointer-events:none;transition:left .18s cubic-bezier(.4,0,.2,1),transform .12s ease}",
					".dpo-stop{flex:1;min-width:0;height:100%;background:transparent;border:none;padding:0;cursor:pointer}",
					".dpo-stop:disabled{cursor:not-allowed}",
					".dpo-slider-value{flex:0 0 auto;font-size:11px;font-weight:500;color:var(--dsw-alias-label-primary,#eee);white-space:nowrap}",					".dpo-model{display:inline-flex;align-items:center;gap:5px;height:24px;flex:0 1 auto;min-width:46px;max-width:130px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1,#444);border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px;cursor:pointer;white-space:nowrap}",
					".dpo-model:hover{border-color:var(--dsw-alias-state-business-primary,#4a9eff);color:var(--dsw-alias-state-business-primary,#4a9eff)}",
					".dpo-model-k{color:var(--dsw-alias-label-caption,#777);flex:0 0 auto}",
					".dpo-model-v{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
					".dpo-pop{position:fixed;z-index:90;width:258px;overflow:auto;background:var(--dsw-specific-tip,#1b1b1b);border:1px solid var(--dsw-alias-border-l1,#444);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:12px;padding:6px}",
					".dpo-pop-sliders{display:flex;gap:12px;padding:2px 6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#333);margin-bottom:6px}",
					".dpo-pop-head{padding:4px 6px 6px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px}",
					".dpo-pop-group{margin-bottom:4px}",
					".dpo-pop-gtitle{padding:3px 6px;color:var(--dsw-alias-label-caption,#777);font-size:11px}",
					".dpo-pop-item{display:block;width:100%;text-align:left;border:none;background:transparent;color:var(--dsw-alias-label-primary,#eee);font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer}",
					".dpo-pop-item:hover{background:rgba(74,158,255,.16)}",
					".dpo-pop-empty{padding:6px;color:var(--dsw-alias-label-caption,#777)}",
					".dpo-pop-foot{display:flex;gap:6px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l1,#333)}",
										"@media (max-width:1480px){.dpo-slider-track{flex-basis:104px;min-width:88px}.dpo-model{max-width:132px}.dpo-controls{gap:10px}}",
					"@media (max-width:1240px){.dpo-slider-track{flex-basis:88px;min-width:76px}.dpo-model{max-width:112px}.dpo-slider-value{font-size:12px}.dpo-controls{gap:9px}}",
					"@media (max-width:1080px){.dpo-model .dpo-model-k{display:none}}",					".dpo-notice{flex:0 0 auto;font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(74,158,255,.15);color:var(--dsw-alias-state-business-primary,#4a9eff);white-space:nowrap}",
					".dpo-count{flex:0 0 auto;font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(74,158,255,.15);color:#4a9eff}",
					".dpo-overlay{position:fixed;left:0;top:0;width:460px;max-height:min(78vh,660px);min-width:360px;min-height:240px;display:flex;flex-direction:column;pointer-events:auto;will-change:transform;touch-action:none;background:var(--dsw-specific-tip,#1b1b1b);border:1px solid var(--dsw-alias-border-l1,#444);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.35);font-size:12px;overflow:hidden}",
					".dpo-overlay-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column}",
					".dpo-overlay.dpo-sizing{user-select:none}",
					".dpo-size-grip{position:absolute;right:2px;bottom:2px;width:14px;height:14px;cursor:nwse-resize;border-right:2px solid var(--dsw-alias-label-tertiary,#888);border-bottom:2px solid var(--dsw-alias-label-tertiary,#888);border-bottom-right-radius:4px;opacity:.75}",
					".dpo-size-grip:hover{opacity:1;border-color:var(--dsw-alias-state-business-primary,#4a9eff)}",
					".dpo-head-hint{color:var(--dsw-alias-label-caption,#777);font-size:10px;white-space:nowrap;cursor:grab}",
					".dpo-overlay-head{cursor:grab;user-select:none}",
					".dpo-dragging .dpo-overlay-head{cursor:grabbing}",
					".dpo-overlay-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#333);color:var(--dsw-alias-label-primary,#eee);position:sticky;top:0;z-index:2;background:var(--dsw-specific-tip,#1b1b1b);border-radius:12px 12px 0 0}",
					".dpo-x{border:none;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1}",
					".dpo-overlay-src{padding:4px 10px;color:var(--dsw-alias-label-tertiary,#888);font-size:11px}",
					".dpo-overlay-body{padding:8px 10px;overflow:auto;white-space:pre-wrap;color:var(--dsw-alias-label-secondary,#ccc)}",
					".dpo-run{display:flex;flex-direction:column;gap:6px;padding:8px 10px}",
					".dpo-run-status{color:var(--dsw-alias-label-tertiary,#999);font-size:11px}",
					".dpo-pane{border:1px solid var(--dsw-alias-border-l1,#333);border-radius:8px;padding:6px 8px;max-height:84px;overflow:auto}",
					".dpo-pane-title{color:var(--dsw-alias-label-tertiary,#888);font-size:11px;margin-bottom:4px}",
					".dpo-pane-body{white-space:pre-wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#ccc)}",
					".dpo-review{display:flex;flex-direction:column;gap:6px;padding:8px 10px}",
					".dpo-review-text{width:100%;box-sizing:border-box;min-height:110px;max-height:220px;overflow-y:auto;resize:vertical;white-space:pre-wrap;background:var(--dsw-alias-bg-layer-1,#141414);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-l1,#444);border-radius:8px;padding:6px 8px;font-size:12px;line-height:1.5;font-family:inherit}",
					".dpo-btn.danger{flex:1;height:26px;border-radius:8px;border:1px solid #d9534f;background:#d9534f;color:#fff;font-size:11px;cursor:pointer}",
					".dpo-btn.primary{flex:1;height:26px;border-radius:8px;border:1px solid var(--dsw-alias-state-business-primary,#4a9eff);background:var(--dsw-alias-state-business-primary,#4a9eff);color:#fff;font-size:11px;cursor:pointer}",
					".dpo-run-error{display:flex;align-items:center;gap:8px;color:#f2777a;font-size:11px;word-break:break-all}",
					".dpo-trace{border-top:1px solid var(--dsw-alias-border-l1,#333);max-height:92px;overflow:auto}",
					".dpo-trace-head{padding:4px 10px;color:var(--dsw-alias-label-tertiary,#888);font-size:11px}",
					".dpo-trace-row{display:flex;gap:6px;padding:2px 10px;font-size:11px;color:var(--dsw-alias-label-secondary,#bbb)}",
					".dpo-trace-tool{flex:0 0 auto;color:var(--dsw-alias-state-business-primary,#4a9eff)}",
					".dpo-trace-args{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
					".dpo-trace-meta{flex:0 0 auto;color:var(--dsw-alias-label-caption,#777)}",
					".dpo-trace-empty{padding:6px 10px;color:var(--dsw-alias-label-caption,#777);font-size:11px}",
					".dpo-overlay-actions{display:flex;gap:8px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1,#333)}",
					".dpo-review .dpo-overlay-actions{position:sticky;bottom:0;z-index:2;background:var(--dsw-specific-tip,#1b1b1b)}",
					".dpo-regen-ask{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1,#444);border-radius:8px;padding:6px 8px;background:var(--dsw-alias-bg-layer-1,#141414)}",
					".dpo-regen-input{width:100%;box-sizing:border-box;height:26px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#444);background:transparent;color:var(--dsw-alias-label-primary,#eee);font-size:12px;padding:0 8px;font-family:inherit}",
					".dpo-btn{flex:1;height:26px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#444);background:transparent;color:var(--dsw-alias-label-secondary,#ccc);font-size:11px;cursor:pointer}",
					".dpo-btn.primary{border-color:var(--dsw-alias-state-business-primary,#4a9eff);background:var(--dsw-alias-state-business-primary,#4a9eff);color:#fff}",

					/* ══════════ v51 精致化视觉层（追加覆写：只改观感与动效，不动几何/拦截逻辑） ══════════ */
					".dpo-controls,.dpo-pop,.dpo-overlay{",
					"  --dpo-acc:var(--dsw-alias-state-business-primary,#4a9eff);",
					"  --dpo-acc-2:color-mix(in srgb,var(--dpo-acc) 62%,#ffffff);",
					"  --dpo-acc-12:color-mix(in srgb,var(--dpo-acc) 12%,transparent);",
					"  --dpo-acc-22:color-mix(in srgb,var(--dpo-acc) 22%,transparent);",
					"  --dpo-acc-40:color-mix(in srgb,var(--dpo-acc) 40%,transparent);",
					"  --dpo-surface:var(--dsw-specific-tip,#1b1b1b);",
					"  --dpo-line:var(--dsw-alias-border-l1,#3a3a3a);",
					"  --dpo-hi:rgba(255,255,255,.07);",
					"  --dpo-ease:cubic-bezier(.22,1,.36,1);",
					"  --dpo-spring:cubic-bezier(.34,1.56,.64,1);",
					"  --dpo-shadow-1:0 1px 2px rgba(0,0,0,.28),0 2px 8px rgba(0,0,0,.24);",
					"  --dpo-shadow-2:0 2px 6px rgba(0,0,0,.30),0 18px 48px rgba(0,0,0,.42);",
					"}",
					"@keyframes dpo-pop-in{from{opacity:0;transform:translateY(10px) scale(.965)}to{opacity:1;transform:none}}",
					"@keyframes dpo-ov-in{from{opacity:0}to{opacity:1}}",
					"@keyframes dpo-ov-rise{from{opacity:0;transform:translateY(6px) scale(.988)}to{opacity:1;transform:none}}",
					"@keyframes dpo-caret{0%,45%{opacity:1}50%,100%{opacity:0}}",
					"@keyframes dpo-pulse{0%{box-shadow:0 0 0 0 var(--dpo-acc-40)}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}",
					"@keyframes dpo-shimmer{from{background-position:-160% 0}to{background-position:260% 0}}",
					"@keyframes dpo-notice-in{from{opacity:0;transform:translateY(-4px) scale(.96)}to{opacity:1;transform:none}}",
					"@keyframes dpo-tick{0%{transform:scale(1)}45%{transform:scale(1.22)}100%{transform:scale(1)}}",
					/* 滚动条精致化 */
					".dpo-overlay-scroll::-webkit-scrollbar,.dpo-pane::-webkit-scrollbar,.dpo-pop::-webkit-scrollbar,.dpo-overlay-body::-webkit-scrollbar,.dpo-trace::-webkit-scrollbar,.dpo-review-text::-webkit-scrollbar{width:8px;height:8px}",
					".dpo-overlay-scroll::-webkit-scrollbar-thumb,.dpo-pane::-webkit-scrollbar-thumb,.dpo-pop::-webkit-scrollbar-thumb,.dpo-overlay-body::-webkit-scrollbar-thumb,.dpo-trace::-webkit-scrollbar-thumb,.dpo-review-text::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-caption,#777) 45%,transparent);border-radius:8px;border:2px solid transparent;background-clip:padding-box}",
					".dpo-overlay-scroll::-webkit-scrollbar-thumb:hover,.dpo-pane::-webkit-scrollbar-thumb:hover,.dpo-pop::-webkit-scrollbar-thumb:hover{background:var(--dpo-acc-40);background-clip:padding-box}",
					".dpo-overlay-scroll::-webkit-scrollbar-track,.dpo-pane::-webkit-scrollbar-track,.dpo-pop::-webkit-scrollbar-track{background:transparent}",
					/* 控件行：滑块 */
					".dpo-controls{gap:10px}",
					".dpo-slider{height:26px;gap:8px}",
					".dpo-slider-track{height:18px}",
					".dpo-slider-track::before{top:7px;height:4px;border-radius:999px;background:linear-gradient(180deg,rgba(0,0,0,.28),rgba(0,0,0,.10));box-shadow:inset 0 1px 2px rgba(0,0,0,.45),0 1px 0 var(--dpo-hi)}",
					".dpo-slider-fill{top:7px;height:4px;border-radius:999px;background:linear-gradient(90deg,var(--dpo-acc),var(--dpo-acc-2));box-shadow:0 0 10px var(--dpo-acc-40);transition:width .26s var(--dpo-ease)}",
					".dpo-slider-thumb{top:2px;width:14px;height:14px;margin-left:-7px;background:radial-gradient(circle at 35% 30%,#fff,var(--dpo-acc-2) 45%,var(--dpo-acc));box-shadow:0 0 0 2px var(--dpo-surface),0 0 0 3px var(--dpo-acc-22),0 2px 6px rgba(0,0,0,.45);transition:left .26s var(--dpo-ease),transform .18s var(--dpo-spring),box-shadow .2s ease}",
					".dpo-slider:hover .dpo-slider-thumb{transform:scale(1.1);box-shadow:0 0 0 2px var(--dpo-surface),0 0 0 4px var(--dpo-acc-22),0 3px 10px rgba(0,0,0,.5)}",
					".dpo-slider:active .dpo-slider-thumb{transform:scale(.94)}",
					".dpo-slider[data-disabled=\"true\"] .dpo-slider-thumb{animation:none}",
					".dpo-stop{position:relative}",
					".dpo-stop::after{content:\"\";position:absolute;left:50%;top:5px;width:4px;height:4px;margin-left:-2px;border-radius:50%;background:var(--dsw-alias-label-caption,#777);opacity:.5;transition:transform .22s var(--dpo-spring),background .2s,opacity .2s}",
					".dpo-stop[data-on=\"true\"]::after{background:var(--dpo-acc);opacity:1;transform:scale(1.5)}",
					".dpo-slider:hover .dpo-stop::after{opacity:.85}",
					".dpo-slider-value{font-weight:600;letter-spacing:.2px;padding:1px 7px;border-radius:999px;background:var(--dpo-acc-12);border:1px solid transparent;transition:background .2s,color .2s,transform .18s var(--dpo-spring)}",
					".dpo-slider[data-disabled=\"true\"] .dpo-slider-value{background:transparent;color:var(--dsw-alias-label-caption,#777)}",
					".dpo-slider-value{animation:dpo-tick .32s var(--dpo-spring)}",
					/* 控件行：模型胶囊 */
					".dpo-model{height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dpo-line);background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 5%,transparent),transparent);box-shadow:var(--dpo-shadow-1);transition:transform .16s var(--dpo-spring),border-color .2s,color .2s,box-shadow .22s}",
					".dpo-model:hover{transform:translateY(-1px);border-color:var(--dpo-acc);color:var(--dpo-acc);box-shadow:0 2px 10px var(--dpo-acc-22),var(--dpo-shadow-1)}",
					".dpo-model:active{transform:translateY(0) scale(.98)}",
					".dpo-model[data-open=\"true\"]{border-color:var(--dpo-acc);color:var(--dpo-acc);box-shadow:0 0 0 3px var(--dpo-acc-12),var(--dpo-shadow-1)}",
					".dpo-model-k{font-size:10px;opacity:.85}",
					".dpo-model-caret{flex:0 0 auto;font-size:9px;opacity:.6;transition:transform .22s var(--dpo-spring)}",
					".dpo-model[data-open=\"true\"] .dpo-model-caret{transform:rotate(180deg);opacity:1}",
					".dpo-model::before{content:none}",
					".dpo-model[data-default=\"true\"]{color:var(--dsw-alias-label-tertiary,#999)}",
					/* 计数与提示 */
					".dpo-count{background:var(--dpo-acc-12);border:1px solid var(--dpo-acc-22);font-weight:600;letter-spacing:.2px}",
					".dpo-notice{animation:dpo-notice-in .26s var(--dpo-spring);background:var(--dpo-acc-12);border:1px solid var(--dpo-acc-22);box-shadow:0 2px 12px var(--dpo-acc-12);font-weight:500}",
					/* 模型弹层 */
					".dpo-pop{width:272px;padding:8px;border-radius:14px;border:1px solid color-mix(in srgb,var(--dpo-line) 80%,transparent);box-shadow:var(--dpo-shadow-2);animation:dpo-pop-in .24s var(--dpo-spring);transform-origin:bottom left;scrollbar-gutter:stable}",
					"@supports (backdrop-filter:blur(1px)){.dpo-pop{background:color-mix(in srgb,var(--dpo-surface) 86%,transparent);backdrop-filter:blur(18px) saturate(1.3)}}",
					".dpo-pop-head{padding:2px 8px 8px;font-size:11px;letter-spacing:.3px;text-transform:none;color:var(--dsw-alias-label-tertiary,#999)}",
					".dpo-pop-sliders{border-bottom:1px solid color-mix(in srgb,var(--dpo-line) 70%,transparent);padding-bottom:10px;margin-bottom:8px}",
					".dpo-pop-group{margin-bottom:2px}",
					".dpo-pop-gtitle{display:flex;align-items:center;gap:6px;padding:6px 8px 3px;font-size:10.5px;letter-spacing:.4px;color:var(--dsw-alias-label-caption,#8a8a8a)}",
					".dpo-pop-gtitle::after{content:\"\";flex:1 1 auto;height:1px;background:linear-gradient(90deg,color-mix(in srgb,var(--dpo-line) 80%,transparent),transparent)}",
					".dpo-pop-item{position:relative;display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:9px;font-size:12px;transition:background .16s ease,color .16s ease,padding-left .2s var(--dpo-ease),box-shadow .18s ease;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
					".dpo-pop-item:hover{background:var(--dpo-acc-12);color:var(--dpo-acc);padding-left:13px;box-shadow:inset 2px 0 0 var(--dpo-acc)}",
					".dpo-pop-item[data-selected=\"true\"]{background:var(--dpo-acc-12);color:var(--dpo-acc);font-weight:600}",
					".dpo-pop-item[data-selected=\"true\"]::after{content:\"✓\";margin-left:auto;font-size:11px;opacity:.9}",
					".dpo-pop-item[data-session=\"true\"]::before{content:\"\";flex:0 0 auto;width:5px;height:5px;border-radius:50%;background:var(--dpo-acc);box-shadow:0 0 6px var(--dpo-acc-40)}",
					".dpo-pop-chip{margin-left:auto;font-size:9.5px;padding:1px 6px;border-radius:999px;background:var(--dpo-acc-12);color:var(--dpo-acc);letter-spacing:.2px}",
					".dpo-pop-empty{padding:10px 8px;font-size:11px;color:var(--dsw-alias-label-caption,#888)}",
					".dpo-pop-foot{gap:6px;padding-top:8px;border-top:1px solid color-mix(in srgb,var(--dpo-line) 70%,transparent)}",
					/* 浮层 */
					".dpo-overlay{border-radius:16px;border:1px solid color-mix(in srgb,var(--dpo-line) 85%,transparent);box-shadow:var(--dpo-shadow-2),inset 0 1px 0 var(--dpo-hi);animation:dpo-ov-in .2s var(--dpo-ease)}",
					"@supports (backdrop-filter:blur(1px)){.dpo-overlay{background:color-mix(in srgb,var(--dpo-surface) 88%,transparent);backdrop-filter:blur(16px) saturate(1.2)}}",
					".dpo-overlay-scroll{animation:dpo-ov-rise .3s var(--dpo-spring)}",
					".dpo-overlay-head{padding:9px 12px;border-bottom:1px solid color-mix(in srgb,var(--dpo-line) 70%,transparent);background:linear-gradient(180deg,var(--dpo-hi),transparent)}",
					".dpo-overlay-head::before{content:\"\";flex:0 0 auto;width:7px;height:7px;margin-right:8px;border-radius:50%;background:var(--dsw-alias-label-caption,#777);transition:background .2s}",
					".dpo-overlay[data-state=\"running\"] .dpo-overlay-head::before{background:var(--dpo-acc);animation:dpo-pulse 1.6s ease-out infinite}",
					".dpo-overlay[data-state=\"done\"] .dpo-overlay-head::before{background:#3ecf8e;box-shadow:0 0 8px rgba(62,207,142,.5)}",
					".dpo-overlay[data-state=\"error\"] .dpo-overlay-head::before{background:#f2777a;box-shadow:0 0 8px rgba(242,119,122,.5)}",
					".dpo-x{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 9px;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#bbb);font-size:11px;cursor:pointer;transition:background .18s,color .18s,border-color .18s,transform .16s var(--dpo-spring)}",
					".dpo-x:hover{background:rgba(242,119,122,.14);color:#f2777a;border-color:rgba(242,119,122,.35);transform:translateX(-1px)}",
					".dpo-x:active{transform:translateX(-1px) scale(.97)}",
					".dpo-head-hint{font-size:10px;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-caption,#777) 14%,transparent)}",
					".dpo-overlay-src{padding:5px 12px;font-size:10.5px;letter-spacing:.2px}",
					".dpo-run{padding:10px 12px;gap:8px}",
					".dpo-run-status{display:flex;align-items:center;gap:8px;font-size:10.5px;letter-spacing:.2px}",
					".dpo-overlay[data-state=\"running\"] .dpo-run-status::after{content:\"\";flex:1 1 auto;height:2px;border-radius:2px;background:linear-gradient(90deg,transparent,var(--dpo-acc),transparent);background-size:160% 100%;animation:dpo-shimmer 1.4s linear infinite;opacity:.7}",
					".dpo-pane{border-radius:12px;padding:8px 10px;border-color:color-mix(in srgb,var(--dpo-line) 80%,transparent);background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 3%,transparent),transparent);box-shadow:inset 0 1px 0 var(--dpo-hi);transition:border-color .2s,box-shadow .2s}",
					".dpo-pane:hover{border-color:var(--dpo-acc-22);box-shadow:inset 0 1px 0 var(--dpo-hi),0 2px 12px rgba(0,0,0,.18)}",
					".dpo-pane-title{display:flex;align-items:center;gap:6px;font-size:10.5px;letter-spacing:.4px;text-transform:none}",
					".dpo-pane-title::before{content:\"\";width:5px;height:5px;border-radius:50%;background:var(--dpo-acc);opacity:.75}",
					".dpo-pane[data-kind=\"text\"] .dpo-pane-title::before{background:#c08cff}",
					".dpo-pane[data-live=\"true\"] .dpo-pane-title::before{animation:dpo-pulse 1.5s ease-out infinite}",
					".dpo-pane[data-live=\"true\"] .dpo-pane-body::after{content:\"▍\";margin-left:1px;color:var(--dpo-acc);animation:dpo-caret 1.05s steps(1,end) infinite}",
					".dpo-pane-body{font-size:11.5px;line-height:1.55}",
					".dpo-review{gap:8px;padding:10px 12px}",
					".dpo-review-text{border-radius:12px;padding:9px 11px;line-height:1.6;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#141414) 92%,transparent);box-shadow:inset 0 1px 2px rgba(0,0,0,.35);transition:border-color .2s,box-shadow .2s}",
					".dpo-review-text:focus{outline:none;border-color:var(--dpo-acc);box-shadow:inset 0 1px 2px rgba(0,0,0,.35),0 0 0 3px var(--dpo-acc-12)}",
					".dpo-regen-ask{border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#141414) 70%,transparent);box-shadow:inset 0 1px 0 var(--dpo-hi);animation:dpo-notice-in .24s var(--dpo-spring)}",
					".dpo-regen-input{border-radius:10px;height:28px;transition:border-color .2s,box-shadow .2s}",
					".dpo-regen-input:focus{outline:none;border-color:var(--dpo-acc);box-shadow:0 0 0 3px var(--dpo-acc-12)}",
					".dpo-overlay-actions{padding:10px 12px;gap:8px;background:linear-gradient(0deg,var(--dpo-hi),transparent)}",
					".dpo-btn{height:28px;border-radius:10px;font-weight:500;letter-spacing:.2px;transition:transform .16s var(--dpo-spring),box-shadow .22s,background .2s,border-color .2s,color .2s}",
					".dpo-btn:hover{border-color:var(--dpo-acc);color:var(--dpo-acc);box-shadow:0 2px 10px var(--dpo-acc-12)}",
					".dpo-btn:active{transform:scale(.975)}",
					".dpo-btn.primary{border-color:transparent;background:linear-gradient(180deg,var(--dpo-acc-2),var(--dpo-acc));box-shadow:0 2px 10px var(--dpo-acc-22),inset 0 1px 0 rgba(255,255,255,.22)}",
					".dpo-btn.primary:hover{color:#fff;box-shadow:0 4px 16px var(--dpo-acc-40),inset 0 1px 0 rgba(255,255,255,.28)}",
					".dpo-btn.danger{border-color:transparent;background:linear-gradient(180deg,#e2685f,#cf4a41);box-shadow:0 2px 10px rgba(207,74,65,.28),inset 0 1px 0 rgba(255,255,255,.18)}",
					".dpo-btn.danger:hover{color:#fff;box-shadow:0 4px 16px rgba(207,74,65,.42)}",
					".dpo-run-error{border-radius:10px;padding:7px 9px;background:rgba(242,119,122,.10);border:1px solid rgba(242,119,122,.28)}",
					".dpo-trace{border-top:1px solid color-mix(in srgb,var(--dpo-line) 60%,transparent)}",
					".dpo-trace-row{padding:3px 12px;border-radius:8px;transition:background .16s}",
					".dpo-trace-row:hover{background:var(--dpo-acc-12)}",
					".dpo-trace-tool{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px}",
					".dpo-size-grip{width:16px;height:16px;right:3px;bottom:3px;border:none;border-radius:5px;opacity:.7;background:linear-gradient(135deg,transparent 42%,var(--dsw-alias-label-caption,#888) 42%,var(--dsw-alias-label-caption,#888) 52%,transparent 52%,transparent 62%,var(--dsw-alias-label-caption,#888) 62%,var(--dsw-alias-label-caption,#888) 72%,transparent 72%);transition:opacity .18s,transform .18s var(--dpo-spring),background .2s}",
					".dpo-size-grip:hover{opacity:1;transform:scale(1.12);background:linear-gradient(135deg,transparent 42%,var(--dpo-acc) 42%,var(--dpo-acc) 52%,transparent 52%,transparent 62%,var(--dpo-acc) 62%,var(--dpo-acc) 72%,transparent 72%)}",
					/* 降级面板也要好看 */
					".dpo-overlay[data-dpo-degraded=\"1\"] .dpo-overlay-head::before{background:#e0a33e;box-shadow:0 0 8px rgba(224,163,62,.5)}",
					/* 无障碍：尊重系统"减少动态效果" */
					"@media (prefers-reduced-motion:reduce){.dpo-controls *,.dpo-pop *,.dpo-overlay *{animation:none!important;transition:none!important}}",

					/* ══════════ v52 舒适层：更长的滑块 / 更疏朗的留白 / 更大的字号 ══════════ */
					".dpo-controls,.dpo-pop,.dpo-overlay{--dpo-fs-1:12px;--dpo-fs-2:13px;--dpo-fs-3:11.5px}",
					".dpo-controls{gap:10px}",
					".dpo-slider{gap:7px;height:30px}",
					".dpo-slider-track{flex:0 1 148px;min-width:124px;height:20px}",
					".dpo-slider-track::before{top:8px;height:5px}",
					".dpo-slider-fill{top:8px;height:5px}",
					".dpo-slider-thumb{top:3px;width:15px;height:15px;margin-left:-7.5px}",
					".dpo-stop::after{top:6px}",
					".dpo-slider-value{font-size:12.5px;padding:2px 4px}",
					".dpo-model{height:30px;padding:0 11px;font-size:12px;max-width:124px}",
					".dpo-model-k{font-size:11px}",
					".dpo-notice{font-size:12px;padding:3px 10px}",
					".dpo-count{font-size:11px;padding:2px 8px}",
					".dpo-overlay{width:520px;min-width:400px;font-size:var(--dpo-fs-2)}",
					".dpo-overlay-head{padding:12px 16px;gap:10px}",
					".dpo-x{height:26px;padding:0 11px;font-size:12px}",
					".dpo-head-hint{font-size:11px;padding:2px 9px}",
					".dpo-overlay-src{padding:7px 16px;font-size:11.5px;line-height:1.6}",
					".dpo-run{padding:14px 16px;gap:12px}",
					".dpo-run-status{font-size:11.5px}",
					".dpo-pane{padding:11px 13px;max-height:132px;border-radius:13px}",
					".dpo-pane-title{font-size:11.5px;margin-bottom:7px;letter-spacing:.5px}",
					".dpo-pane-body{font-size:var(--dpo-fs-2);line-height:1.68}",
					".dpo-overlay-body{padding:12px 16px;font-size:var(--dpo-fs-2);line-height:1.65}",
					".dpo-review{gap:11px;padding:14px 16px}",
					".dpo-review-text{font-size:var(--dpo-fs-2);line-height:1.72;min-height:150px;max-height:300px;padding:12px 14px;border-radius:13px}",
					".dpo-review .dpo-pane-title{font-size:12px;margin-bottom:2px}",
					".dpo-regen-ask{gap:9px;padding:11px 13px;border-radius:13px}",
					".dpo-regen-ask .dpo-pane-title{font-size:12px}",
					".dpo-regen-input{height:32px;font-size:var(--dpo-fs-2);border-radius:11px;padding:0 11px}",
					".dpo-overlay-actions{padding:13px 16px;gap:10px}",
					".dpo-btn{height:32px;font-size:var(--dpo-fs-1);border-radius:11px}",
					".dpo-run-error{font-size:11.5px;padding:9px 11px;line-height:1.6}",
					".dpo-trace{max-height:120px}",
					".dpo-trace-head{padding:7px 16px;font-size:11.5px}",
					".dpo-trace-row{padding:4px 16px;font-size:var(--dpo-fs-3);gap:8px}",
					".dpo-trace-tool{font-size:11.5px}",
					".dpo-trace-empty{padding:9px 16px;font-size:11.5px}",
					".dpo-size-grip{width:18px;height:18px;right:4px;bottom:4px;z-index:6}"   /* 必须高于 .dpo-overlay-foot(z-index:3)，否则被底栏盖住拖不动 */,
					".dpo-pop{width:308px;padding:11px;border-radius:15px}",
					".dpo-pop-head{padding:3px 10px 10px;font-size:12px}",
					".dpo-pop-gtitle{padding:8px 10px 5px;font-size:11.5px}",
					".dpo-pop-item{padding:8px 12px;font-size:var(--dpo-fs-2);border-radius:11px;gap:9px}",
					".dpo-pop-item:hover{padding-left:15px}",
					".dpo-pop-chip{font-size:10.5px;padding:2px 8px}",
					".dpo-pop-empty{padding:12px 10px;font-size:12px;line-height:1.6}",
					".dpo-pop-foot{padding-top:11px;gap:8px}",
					"@media (max-width:1480px){.dpo-controls{gap:10px}.dpo-slider-track{flex-basis:104px;min-width:88px}.dpo-model{max-width:132px}}",
					"@media (max-width:1240px){.dpo-controls{gap:9px}.dpo-slider-track{flex-basis:88px;min-width:76px}.dpo-model{max-width:112px}}",
					"@media (max-width:1080px){.dpo-controls{gap:8px}.dpo-slider-track{flex-basis:72px;min-width:60px}}",
					/* 常驻操作栏 + token 徽标（v54） */
					".dpo-overlay-foot{flex:0 0 auto;position:relative;z-index:3;border-top:1px solid color-mix(in srgb,var(--dpo-line) 70%,transparent);background:linear-gradient(0deg,var(--dpo-hi),transparent)}",
					".dpo-foot-inner{display:flex;flex-direction:column}",
					".dpo-foot-inner .dpo-overlay-actions{border-top:none;padding:10px 22px 10px 14px}",
					".dpo-overlay-foot .dpo-btn{flex:1 1 0;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
					"@media (max-height:640px){.dpo-pane{max-height:min(132px,22vh)}.dpo-review-text{min-height:min(150px,20vh)}.dpo-trace{max-height:72px}}",
					"@media (max-height:470px){.dpo-pane{max-height:min(132px,18vh)}.dpo-review-text{min-height:min(150px,16vh)}.dpo-trace{display:none}.dpo-overlay-head{padding:9px 13px}.dpo-overlay-src{display:none}}",
					".dpo-tok-chip{margin-left:auto;font-size:10.5px;font-weight:600;letter-spacing:.2px;padding:1px 7px;border-radius:999px;background:var(--dpo-acc-12);color:var(--dpo-acc);border:1px solid var(--dpo-acc-22);white-space:nowrap}",
					".dpo-pane-title .dpo-tok-chip{margin-left:0}",
					".dpo-pane-title .dpo-tok-chip:first-of-type{margin-left:auto}",
					".dpo-pane-title{gap:7px}",
					".dpo-tok-muted{background:color-mix(in srgb,var(--dsw-alias-label-caption,#777) 14%,transparent);color:var(--dsw-alias-label-caption,#8a8a8a);border-color:transparent;font-weight:500}",
					".dpo-tok-live{animation:dpo-pulse 1.6s ease-out infinite}",
					".dpo-hint-quiet{font-size:10.5px;color:var(--dsw-alias-label-caption,#8a8a8a);line-height:1.5}",
					".dpo-help-meta{margin-top:12px;padding-top:9px;border-top:1px solid color-mix(in srgb,var(--dpo-line) 60%,transparent);font-size:10.5px;color:var(--dsw-alias-label-caption,#8a8a8a);text-align:center;letter-spacing:.2px}",
					/* 使用帮助 */
					".dpo-help{flex:0 0 auto;width:30px;height:30px;padding:0;border-radius:50%;border:1px solid var(--dpo-line);background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 5%,transparent),transparent);color:var(--dsw-alias-label-secondary,#aaa);font-size:14px;font-weight:600;line-height:1;cursor:pointer;box-shadow:var(--dpo-shadow-1);transition:transform .16s var(--dpo-spring),border-color .2s,color .2s,box-shadow .22s}",
					".dpo-help:hover{transform:translateY(-1px) rotate(8deg);border-color:var(--dpo-acc);color:var(--dpo-acc);box-shadow:0 2px 10px var(--dpo-acc-22)}",
					".dpo-help:active{transform:scale(.96)}",
					".dpo-help[data-open=\"true\"]{border-color:var(--dpo-acc);color:var(--dpo-acc);box-shadow:0 0 0 3px var(--dpo-acc-12)}",
					".dpo-help-pop{width:396px;padding:14px 16px}",
					".dpo-help-sec{margin:12px 0 6px;font-size:11.5px;letter-spacing:.4px;color:var(--dsw-alias-label-caption,#8a8a8a);display:flex;align-items:center;gap:8px}",
					".dpo-help-sec::after{content:\"\";flex:1 1 auto;height:1px;background:linear-gradient(90deg,color-mix(in srgb,var(--dpo-line) 80%,transparent),transparent)}",
					".dpo-help-sec:first-of-type{margin-top:4px}",
					".dpo-help-row{display:flex;gap:10px;padding:3px 0;font-size:12px;line-height:1.6}",
					".dpo-help-k{flex:0 0 62px;color:var(--dpo-acc);font-weight:600}",
					".dpo-help-v{flex:1 1 auto;color:var(--dsw-alias-label-secondary,#c9c9c9)}",
					".dpo-help-tip{margin-top:13px;padding:10px 12px;border-radius:11px;background:var(--dpo-acc-12);border:1px solid var(--dpo-acc-22);color:var(--dsw-alias-label-primary,#eee);font-size:12.5px;line-height:1.6;font-weight:600}",
									"/* ══════════ v60 主题适配层：修正 token 名 + 对齐 DSH 亮/暗主题（追加覆写，不动几何与拦截逻辑） ══════════ */",
					"/* ── 1) 原代码引用的 bg-l1 在 DSH 的设计 token 中并不存在（正确名为 bg-layer-1），",
					"   其回退值 #141414 是暗色，于是浅色主题下「产出」输入框会渲染成一整块黑底。 ── */",
					".dpo-review-text{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#141414) 92%,transparent)}",
					".dpo-regen-ask{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#141414) 70%,transparent)}",
					"/* ── 2) 亮色主题开关：v51「精致化」层的黑色阴影(rgba(0,0,0,.28~.42))与白色高光(--dpo-hi)",
					"   是暗色主题专属语言，在浅色下只会发灰发脏，这里按主题重算。 ── */",
					"body:not([data-ds-dark-theme]) :is(.dpo-controls,.dpo-pop,.dpo-overlay){",
					"  --dpo-line:var(--dsw-alias-border-l2,rgba(0,0,0,.10));",
					"  --dpo-hi:rgba(0,0,0,.02);",
					"  --dpo-acc-2:color-mix(in srgb,var(--dpo-acc) 85%,#ffffff);",
					"  --dpo-shadow-1:0 1px 2px rgba(0,0,0,.06),0 2px 8px rgba(0,0,0,.06);",
					"  --dpo-shadow-2:0 2px 6px rgba(0,0,0,.07),0 18px 48px rgba(0,0,0,.12)",
					"}",
					"/* ── 3) 滑块轨道在白底上几乎不可见（原轨道是暗色专用的白高光），加深并按主题重设 ── */",
					"body:not([data-ds-dark-theme]) .dpo-slider-track::before{",
					"  background:linear-gradient(180deg,rgba(0,0,0,.13),rgba(0,0,0,.06));",
					"  box-shadow:inset 0 1px 2px rgba(0,0,0,.12)",
					"}",
					"body:not([data-ds-dark-theme]) .dpo-pane:hover{box-shadow:inset 0 1px 0 var(--dpo-hi),0 2px 10px rgba(0,0,0,.07)}",
					"body:not([data-ds-dark-theme]) .dpo-review-text{box-shadow:inset 0 1px 2px rgba(0,0,0,.04)}",
					"body:not([data-ds-dark-theme]) .dpo-review-text:focus{box-shadow:inset 0 1px 2px rgba(0,0,0,.04),0 0 0 3px var(--dpo-acc-12)}",
					"/* ── 4) 滑块手柄：去掉会在浅色下漏出容器底色的「挖空环」，改为通用投影 ── */",
					".dpo-slider-thumb{box-shadow:0 1px 3px rgba(0,0,0,.30),0 0 0 3px var(--dpo-acc-22)}",
					".dpo-slider:hover .dpo-slider-thumb{box-shadow:0 1px 4px rgba(0,0,0,.36),0 0 0 4px var(--dpo-acc-22)}",
					".dpo-slider:active .dpo-slider-thumb{box-shadow:0 1px 2px rgba(0,0,0,.30),0 0 0 5px var(--dpo-acc-22)}",
					"/* ── 5) 状态色改用 DSH 语义 token（原为硬编码，只有暗色下协调；圆点光晕改为柔环） ── */",
					".dpo-overlay[data-state=\"done\"] .dpo-overlay-head::before{background:var(--dsw-alias-state-success-primary,#3ecf8e);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#3ecf8e) 20%,transparent)}",
					".dpo-overlay[data-state=\"error\"] .dpo-overlay-head::before{background:var(--dsw-alias-state-error-primary,#f2777a);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary,#f2777a) 20%,transparent)}",
					".dpo-overlay[data-dpo-degraded=\"1\"] .dpo-overlay-head::before{background:var(--dsw-alias-state-warn-primary,#e0a33e);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a33e) 20%,transparent)}",
					".dpo-run-error{color:var(--dsw-alias-state-error-primary,#f2777a);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f2777a) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f2777a) 28%,transparent)}",
					".dpo-x:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f2777a) 14%,transparent);color:var(--dsw-alias-state-error-primary,#f2777a);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f2777a) 35%,transparent)}",
					"/* ── 6) 滚动条改用 DSH 滚动条 token，避免浅色下出现一条灰黑的假滚动条 ── */",
					".dpo-overlay-scroll::-webkit-scrollbar-thumb,.dpo-pane::-webkit-scrollbar-thumb,.dpo-pop::-webkit-scrollbar-thumb,.dpo-overlay-body::-webkit-scrollbar-thumb,.dpo-trace::-webkit-scrollbar-thumb,.dpo-review-text::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l1,color-mix(in srgb,var(--dsw-alias-label-caption,#777) 45%,transparent));background-clip:padding-box;border:2px solid transparent;border-radius:8px}",
					".dpo-overlay-scroll::-webkit-scrollbar-thumb:hover,.dpo-pane::-webkit-scrollbar-thumb:hover,.dpo-pop::-webkit-scrollbar-thumb:hover,.dpo-overlay-body::-webkit-scrollbar-thumb:hover,.dpo-trace::-webkit-scrollbar-thumb:hover,.dpo-review-text::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l1,var(--dpo-acc-40));background-clip:padding-box}",
					"/* ══════════ v61 结构修复层：真实渲染后才暴露的排版事故 ══════════ */",
					"/* ── 7) 弹层底部 3 个中文按钮在 308px 宽内必然折行（「恢复默认（跟随会话）」被断成两行）",
					"   → 改成「主操作独占一行 + 两枚并排」。用 :has(nth-child(3)) 限定，避免波及只有「知道了」的帮助弹层。 ── */",
					".dpo-pop-foot:has(.dpo-btn:nth-child(3)){display:grid;grid-template-columns:1fr 1fr;gap:6px}",
					".dpo-pop-foot:has(.dpo-btn:nth-child(3)) .dpo-btn:first-child{grid-column:1 / -1}",
					".dpo-pop-foot .dpo-btn{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
					"/* ── 8) 复核输入框：去掉浏览器原生 resize 手柄，它和右下角 .dpo-size-grip 抢同一个角 ── */",
					".dpo-review-text{resize:none}",
					"/* ── 9) 危险操作降调：DSH 不用实心红做次级按钮，重新生成也并非破坏性操作 ── */",
					".dpo-btn.danger{",
					"  background:transparent;",
					"  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9534f) 38%,transparent);",
					"  color:var(--dsw-alias-state-error-primary,#cf4a41);",
					"  box-shadow:none",
					"}",
					".dpo-btn.danger:hover{",
					"  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9534f) 12%,transparent);",
					"  border-color:var(--dsw-alias-state-error-primary,#cf4a41);",
					"  color:var(--dsw-alias-state-error-primary,#cf4a41);",
					"  box-shadow:none",
					"}",
					"/* ── 10) 标签层级：当「前缀」用的字不该取最淡的 caption ── */",
					".dpo-model-k{color:var(--dsw-alias-label-tertiary,#999)}",
					".dpo-pop-gtitle{color:var(--dsw-alias-label-tertiary,#999)}",
					"/* ══════════ v62 向 DSH 原生视觉语言对齐 ══════════",
					"   基准来自真实 DSH 界面（dsh-native-01.png）与并排对比图（cmp-02.png）：",
					"   DSH 的浮起面板不用边框、不用重投影，而是 0.5px 发丝描边 + 两层极淡柔光（--dsw-elevation-*），",
					"   圆角约 12px；图标/文字控件默认无边框无底色，hover 才浮出浅灰底。",
					"   插件的自制阴影（--dpo-shadow-2）与实心白胶囊正好相反，是「不像原生」的主因。 */",
					"/* ── 11) 弹层/浮层：换成 DSH 的 elevation token，圆角 16px → 12px ── */",
					".dpo-pop,",
					".dpo-overlay,",
					".dpo-help-pop{",
					"  border:0;",
					"  border-radius:12px;",
					"  background:var(--dsw-alias-bg-overlay,#fff);",
					"  box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px rgba(0,0,0,.10),0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05))",
					"}",
					"/* ── 12) 主按钮：DSH 的 business 蓝纯色，去掉自制渐变与光晕。",
					"   注意两条陷阱：(a) --dsw-alias-button-primary-fill(=--dsw-alias-brand-primary) 在本主题下是近黑，用了会变灰按钮；",
					"   (b) v60 里 body:not([data-ds-dark-theme]) .dpo-btn.primary 的特异性高于 .dpo-btn.primary，",
					"   必须用同样的前缀才能把光晕清掉。 ── */",
					".dpo-btn.primary{",
					"  background:var(--dsw-alias-state-business-primary,var(--dpo-acc));",
					"  border-color:transparent;",
					"  box-shadow:none",
					"}",
					"body:not([data-ds-dark-theme]) .dpo-btn.primary{box-shadow:none}",
					".dpo-btn.primary:hover{",
					"  background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 86%,#000);",
					"  box-shadow:none",
					"}",
					"/* ── 13) 控件胶囊：DSH 风格 —— 无边框无底色，hover 才出浅灰底 ── */",
					".dpo-controls .dpo-model,",
					".dpo-controls .dpo-help{",
					"  border-color:transparent;",
					"  background:transparent;",
					"  box-shadow:none;",
					"  border-radius:8px;",
					"  color:var(--dsw-alias-label-secondary,#666)",
					"}",
					".dpo-controls .dpo-model:hover,",
					".dpo-controls .dpo-help:hover{",
					"  background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))",
					"}",
					"/* ── 14) 弹层内条目与按钮统一到 DSH 的 8px 圆角尺度 ── */",
					".dpo-pop-item,",
					".dpo-pop-foot .dpo-btn,",
					".dpo-overlay .dpo-btn,",
					".dpo-help-pop .dpo-btn{border-radius:8px}",
					"/* ══════════ v64 · 真实环境（1264x772 实拍）调优 ══════════",
					"   实测依据：.dpo-controls 宽 405px，内含两个外观完全一致、都无可见标签的 130px 滑块",
					"   （data-dpo=\"tier\" / \"perm\"），只能靠 title 悬停分辨，这是可用性上最要紧的缺口。",
					"   而 DSH 原生控件（\"完全权限 ⌄\"、\"deepseek-flash Max ⌄\"）清一色是无边框纯文字。 */",
					"/* ── 15) 纯 CSS 补语义标签（不动 JS）── */",
					".dpo-controls .dpo-slider{display:flex;align-items:center;gap:6px}",
					".dpo-controls .dpo-slider::before{flex:0 0 auto;font-size:12px;line-height:1;font-weight:400;color:var(--dsw-alias-label-tertiary,#8a8a8a)}",
					".dpo-controls .dpo-slider[data-dpo=\"tier\"]::before{content:\"档位\"}",
					".dpo-controls .dpo-slider[data-dpo=\"perm\"]::before{content:\"权限\"}",
					"/* ── 16) 几何：滑块收窄，把预算让给刚加上的标签，控件行反而更紧凑（405px → 376px）── */",
					".dpo-controls{gap:8px}",
					".dpo-controls .dpo-slider-track{flex:0 1 66px;min-width:52px}",
					".dpo-controls .dpo-model{max-width:134px}",
					"/* ── 17) 值文字去彩色胶囊 → 与 DSH 原生纯文字控件同调 ── */",
					".dpo-controls .dpo-slider-value{",
					"  background:transparent;border-color:transparent;box-shadow:none;",
					"  color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:400;font-size:12px;letter-spacing:0;",
					"  padding:0;min-width:2.4em;text-align:left;",
					"}",
					".dpo-controls .dpo-slider[data-disabled=\"true\"] .dpo-slider-value{color:var(--dsw-alias-label-caption,#aaa)}",
					"/* ── 18) 帮助按钮降为 tertiary，hover 才浮出浅灰底（DSH 图标按钮的一致行为）── */",
					".dpo-controls .dpo-help{color:var(--dsw-alias-label-tertiary,#8a8a8a);border-color:transparent;background:transparent}",
					".dpo-controls .dpo-help:hover{color:var(--dsw-alias-label-primary,#1a1a1a);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));border-color:transparent}",
					"/* ── 19) 计数徽标中性化：原为硬编码蓝 rgba(74,158,255,.15) / #4a9eff（client.js:2462）── */",
					".dpo-controls .dpo-count{color:var(--dsw-alias-label-tertiary,#8a8a8a);background:transparent;border-color:var(--dsw-alias-border-l1,#e0e0e0)}",
					"/* ── 20) 滑块降调：原实现是三层叠加的\"暗色主题美学\"——",
					"   client.js:2532 fill 带 box-shadow:0 0 10px var(--dpo-acc-40) 蓝色辉光；",
					"   client.js:2533 thumb 是 radial-gradient(circle at 35% 30%,#fff,var(--dpo-acc-2) 45%,var(--dpo-acc)) 三段径向渐变小珠；",
					"   client.js:2531 轨道是 inset 内阴影深槽。在 DSH 的扁平灰白界面里三样都过度，",
					"   且控件行里同时存在两个蓝色填充条 + DSH 发送按钮，蓝色变成噪音。",
					"   统一改为扁平：细轨道 + 实心品牌色填充 + 白底细描边 thumb，去掉全部辉光。",
					"   几何对齐：track 20px；fill 与轨道线 4px、top 8px（中心 10px）；thumb 13px(border-box) top 3.5px（中心 10px）。 ── */",
					".dpo-controls .dpo-slider-track{height:20px}",
					".dpo-controls .dpo-slider-track::before{top:8px;height:4px;border-radius:999px;background:var(--dsw-alias-border-l1,#dcdcdc);box-shadow:none}",
					".dpo-controls .dpo-slider-fill{top:8px;height:4px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#4176e6);box-shadow:none}",
					".dpo-controls .dpo-slider-thumb{",
					"  top:3.5px;width:13px;height:13px;margin-left:-6.5px;box-sizing:border-box;",
					"  background:var(--dsw-alias-bg-layer-1,#fff);",
					"  border:1.5px solid var(--dsw-alias-state-business-primary,#4176e6);",
					"  box-shadow:0 1px 2px rgba(0,0,0,.18);",
					"  transition:left .2s var(--dpo-ease),transform .15s var(--dpo-spring),box-shadow .2s ease;",
					"}",
					".dpo-controls .dpo-slider:hover .dpo-slider-thumb{transform:scale(1.08);box-shadow:0 1px 3px rgba(0,0,0,.24)}",
					".dpo-controls .dpo-slider:active .dpo-slider-thumb{transform:scale(.95)}",
					"/* ══════════ v65 · 帮助弹层视口溢出修复 ══════════",
					"   实拍发现：.dpo-help 在 y≈427，而帮助弹层内容高约 520px，而它是",
					"   client.js:2450 的 position:fixed + JS「底边贴按钮、向上展开」定位，没有视口钳制，",
					"   于是顶边 = 427-520 ≈ -93，标题「使用帮助 · 提示词优化」被切在视口外。",
					"   因为 pop 高度参与 JS 的 top 计算，限制 max-height 就等价于把顶边钳回来，",
					"   不需要改 JS。常量 380px 是「composer 控件行到视口底」的实测距离，",
					"   再用 min() 兜住小视口；overflow 在基础层已有，这里只补滚动行为。 ── */",
					"/* v65 收尾（v66 时补上 box-sizing：只给 max-height 限的是 content-box，",
					"   总高仍会加上 padding 而溢出 —— 实测限 392 却渲染成 424，加上 border-box 后才得 393）。 */",
					".dpo-pop{box-sizing:border-box;max-height:min(460px,calc(100vh - 380px))}",
					".dpo-help-pop{box-sizing:border-box;max-height:min(460px,calc(100vh - 380px));overscroll-behavior:contain}",
					".dpo-pop{scrollbar-gutter:stable}",
					"/* ══════════ v66 · 两处自我修正（v62/v64 引入的回归）══════════ */",
					"/* ── 21) v62 第 13 条把 .dpo-model 与 .dpo-help 一起设成 border-radius:8px，",
					"   但 .dpo-help 在 client.js:2691 原本是 border-radius:50% 的圆形按钮",
					"   （v51 还给它配了 .dpo-help:hover{transform:translateY(-1px) rotate(8deg)} 的旋转微动效），",
					"   改成圆角方之后圆形语义丢失、旋转动效也失去意义。这里按元素拆开还原。 ── */",
					".dpo-controls .dpo-model{border-radius:8px}",
					".dpo-controls .dpo-help{border-radius:50%}",
					"/* ── 22) 焦点环：鼠标点击 .dpo-help 后浏览器默认 outline 会在极简界面里留下",
					"   一个突兀的白色方块（实拍已见）。鼠标态去掉，键盘导航（:focus-visible）才给",
					"   品牌色细环 —— 既不破坏视觉，又不牺牲无障碍。 ── */",
					".dpo-controls .dpo-help:focus,",
					".dpo-controls .dpo-model:focus{outline:none}",
					".dpo-controls .dpo-help:focus-visible,",
					".dpo-controls .dpo-model:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px}",
					"/* ══════════ v67 · 浮窗标题栏布局修复 + 胶囊降噪 ══════════",
					"   本轮首次拿到 .dpo-overlay（迷你浮窗）的真实渲染 —— 用同构 DOM 注入预览",
					"   （_overlay.js：结构照抄 client.js:1203-1240，所以插件自己的 CSS 真实生效），",
					"   量测发现标题栏三个元素位置全错：‹ 回退 落在 x=107（而非贴着左内边距的 400/16），",
					"   标题落在 238..352，而 head 的内容中心是 644（相对视口）—— 偏右 35px。",
					"   根因不是 CSS 写错，而是布局假设与 DOM 不符：client.js:2471 的",
					"     .dpo-overlay-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;...}",
					"   是按\"3 个子元素\"写的，但 client.js:2578 的",
					"     .dpo-overlay-head::before{content:\"\";flex:0 0 auto;width:7px;height:7px;margin-right:8px;border-radius:50%;...}",
					"   （状态圆点：done=绿 / running=蓝 / error=红）在 flex 容器里同样是 item ——",
					"   4 个 item 让 3 个间隙被均分成 76px（实测 gap 76/76），dpo-x 因此被推离左缘 91px。",
					"   改用 grid 显式排布，使其不再依赖子元素个数：",
					"     圆点(1)+标题(2) 靠左 | 尺寸提示(3) 靠右 | 回退(4) 最右。",
					"   注意 grid-column 与 grid-row 必须成对给：只给 column 时自动放置会按 DOM 顺序",
					"   （::before 排在最前）把标题挤到第二行 —— ov-02.png 实测标题落到 row2 左侧、",
					"   尺寸提示落到 row2 右侧，标题栏被拉成两行。 ── */",
					".dpo-overlay-head{display:grid;grid-template-columns:auto auto 1fr auto;align-items:center;column-gap:10px}",
					".dpo-overlay-head::before{grid-column:1;grid-row:1;margin-right:0;width:6px;height:6px}",
					".dpo-overlay-head > span:not(.dpo-head-hint){grid-column:2;grid-row:1;justify-self:start;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
					".dpo-overlay-head > .dpo-head-hint{grid-column:3;grid-row:1;justify-self:end}",
					".dpo-overlay-head > .dpo-x{grid-column:4;grid-row:1}",
					"/* ── 23) 尺寸提示去胶囊：client.js:2585 给它 border-radius:999px 加半透明底，",
					"   与紧邻的 dpo-x 并排时是两个互相争抢的胶囊。降为 caption 纯文字。 ── */",
					".dpo-head-hint{background:none;padding:0;color:var(--dsw-alias-label-caption,#81858c);font-size:11px}",
					"/* ── 24) 次要 token 徽标去胶囊：一次 done 运行会同时出现 Σ 总 token、思考 tok、思考字数、",
					"   产出 tok、产出字数共 5 个胶囊（实拍可见）。\"N 字\"不需要外壳，",
					"   只保留 tok 计量作为主指标。 ── */",
					".dpo-tok-chip.dpo-tok-muted{background:none;padding:0;color:var(--dsw-alias-label-caption,#81858c);font-size:11px}",
					"/* ── 25) 元信息行弱化：.dpo-overlay-src（\"档位：X · 权限：Y · 拦截累计 N\"）与",
					"   .dpo-run-status（\"档位 X · 已完成 · 首字 Nms\"）都在报档位，两行紧邻时视觉打架。",
					"   把前者降为 caption 级，让它回到\"环境说明\"而非\"状态\"的位置。 ── */",
					".dpo-overlay-src{color:var(--dsw-alias-label-caption,#81858c);font-size:11px}",
					"/* ══════════ v68 · 浮窗内部结构对齐 DSH ══════════",
					"   量测基准（同构注入预览实测）：",
					"     .dpo-pane        padding:11px 13px; border:1px solid rgba(0,0,0,.082); border-radius:13px; bg transparent; box-sizing:content-box",
					"     .dpo-review-text padding:12px 14px; border:1px solid rgba(0,0,0,.04);  border-radius:13px; bg rgba(255,255,255,.92); 13px",
					"     .dpo-btn.danger  bg transparent; border 1px solid rgba(236,19,19,.38); color rgb(236,19,19); height 26px; radius 8px",
					"   DSH 的原生语言：思考/产出用「左侧细竖线 + 缩进」而不是嵌套边框卡片；危险操作不常驻红色。",
					"   token 实测值（浅色主题，供以后直接引用）：",
					"     --dsw-alias-border-l1=#0000000a(4%) / l2=#0000001a(10%) / l3=#0000001f(12%) / l4=#00000029(16%)",
					"     --dsw-alias-bg-layer-1 = layer-2 = bg-base = #fff  ← 浅色下全是白，做层级只能靠边框或半透明叠色",
					"     --dsw-alias-interactive-bg-hover=#2631480f、--dsw-alias-label-caption=#adb2b8 ── */",
					"/* ── 26) pane 去卡片化：13px 圆角与浮窗自身 12px 圆角几乎相同，形成\"卡片套卡片\"。",
					"   改为左侧 2px 竖线。简写下左右边框合计仍是 2px（原各 1px），content-box 下元素总宽不变 ——",
					"   实测 .dpo-pane 仍 480px、内部文本列 451px（原 452px），不挤动布局。 ── */",
					".dpo-pane{border:1px solid transparent;border-left:2px solid var(--dsw-alias-border-l2,#0000001a);border-radius:0}",
					".dpo-pane:hover{background:transparent;box-shadow:none}",
					"/* ── 27) 产出编辑框：原边框约 4% 黑，淡到看不出这是可编辑区（实拍确认）。",
					"   提到 l2(10%) 并收到 10px 圆角。 ── */",
					".dpo-review-text{border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}",
					"/* ── 28) \"重新生成\"降重：原为常驻纯红 rgb(236,19,19) + 红框，把非破坏性操作渲染成告警，",
					"   与旁边的蓝色主按钮争抢注意力。改为中性描边 + 主文字色，危险语义只在 hover 出现。 ── */",
					".dpo-btn.danger{background:transparent;border-color:var(--dsw-alias-border-l2,#0000001a);color:var(--dsw-alias-label-primary,#1a1a1a);box-shadow:none}",
					".dpo-btn.danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 8%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 35%,transparent);color:var(--dsw-alias-state-error-primary,#ec1313)}",
					"/* ══════════ v69 · 控件行的语义与可读性 ══════════",
					"   基准：用 _controls.js 注入真实 DOM（结构照抄 client.js:529-584 的宽屏分支）后，",
					"   在真实 CSS 下量得控件行 458x30px 单行：档位滑块 + 权限滑块 + 模型胶囊 + ? + 计数徽标。",
					"   四个问题按影响排序：",
					"     1) 「权限」与 DSH 原生 composer 的「完全权限 ⌄」同名不同义 —— 后者是工具执行权限，",
					"        插件的这个 2 档滑块管的是\"优化完成后是否先给用户过目再发\"（审查/自动）。",
					"        两者在 composer 里紧邻，是真实的用户困惑来源。",
					"     2) 2 档的\"审查/自动\"用滑块表达，外观与 4 档的档位滑块完全一致，看不出层级差别。",
					"     3) 模型名被截成 \"deepseek-v3.2-e…\"（v64 设的 max-width:134px 不够）。",
					"     4) 计数徽标只有一个孤立的 \"2\"，没有说明它是什么。 ── */",
					"/* ── 29) 更名：权限 → 发送。标签本身是 v64 用 ::before 加的（真实 DOM 里没有这个文本节点），",
					"   所以纯 CSS 就能改；title 仍是原句，hover 可补充完整语义。 ── */",
					".dpo-controls .dpo-slider[data-dpo=\"perm\"]::before{content:\"发送\"}",
					"/* ── 30) 2 档控件去掉蓝色填充：蓝色填充是\"连续量\"的隐喻，审查/自动是二选一，",
					"   用中性轨道 + 两端位置表达更准确，也让它与档位滑块一眼可分。",
					"   实测 fill 从 business 蓝变为 rgba(0,0,0,.1)。 ── */",
					".dpo-controls .dpo-slider[data-dpo=\"perm\"] .dpo-slider-fill{background:var(--dsw-alias-border-l2,#dcdcdc)}",
					"/* ── 31) 模型名放宽到能完整显示 deepseek-v3.2-exp。实测 modelW 134→137 即不再截断",
					"   （modelClipped 由 true 变 false），控件行总宽 458→486px。 ── */",
					".dpo-controls .dpo-model{max-width:156px}",
					"/* ── 32) 计数徽标补语义：原实现（client.js:583）既无 title 也无文本说明。 ── */",
					".dpo-controls .dpo-count::before{content:\"拦截 \"}",
					"/* ══════════ v70 · 浮窗层级（真 bug）+ 颜色语义收敛 ══════════",
					"   本轮把浮窗从\"从未真实渲染验证过\"变成有实拍基准：_overlay.js 把与",
					"   client.js:1203-1240 同构的 .dpo-overlay[data-state=done]（foot-review 态）注入真实",
					"   DSH 页面 —— 插件自己的 CSS 与 DSH 的 --dsw-* token 都是真的。",
					"   三个问题按影响排序：",
					"     1) 浮窗被 DSH composer 盖住一半（真 bug，见 33）",
					"     2) 三种颜色（绿状态点 / 蓝思考点 / 紫产出点）违反 DSH 的单色体系（见 34）",
					"     3) 有值的 token chip 铺品牌蓝底蓝字，但它是次要数值信息（见 35） ── */",
					"/* ── 33) 浮窗层级：.dpo-overlay 是 position:fixed 却从未声明 z-index",
					"   （client.js:2463 基础规则；v51 的 :2574 与 v52 的 :2638 覆写也没加），",
					"   注入预览里 computed 为 auto(≡0) → 被 DSH composer 的卡片压住，",
					"   浮窗下半部的 .dpo-pane[data-kind=text] / .dpo-review / 底部按钮全部不可见不可点。",
					"   硬证据：修复前 elementFromPoint(300,300) 命中 DIV.uV2eYG_card（composer 工作区卡片）、",
					"   ov.contains(pe)===false；修复后命中 DIV.dpo-pane-title、ov.contains(pe)===true。",
					"   ⚠️ 范围界定（重要，别误报为上游 bug）：真实插件的浮窗注册在 DSH 的 `shell.overlay`",
					"   插槽（client.js:3023/3039），该插槽容器是 `DIV.pI_x6G_overlayLayer{position:absolute;",
					"   z-index:20}` —— 20 已高于整页 chrome（DSH composer 的 .wSkVaW_composerStack 只有 z-index:1，",
					"   实测全页 z-index≥20 的元素仅 overlayLayer 一个），所以**真实场景下浮窗本来就不会被盖**。",
					"   本条是「注入预览必需 + 健壮性兜底」：同构预览把浮窗挂在 body 上，没有 overlayLayer 保护。",
					"   取 80 —— 高于 DSH chrome、低于插件自己的 .dpo-pop(z-index:90，从控件行弹出时要能盖住浮窗；",
					"   注意 pop 在 composer 的层里，其 90 是相对整页的，而浮窗的 80 只在 overlayLayer 内生效)。 ── */",
					".dpo-overlay{z-index:80}",
					"/* ── 34) pane 圆点去硬编码紫：client.js:2594 写死 background:#c08cff（产出 pane），",
					"   在 DSH 的单色体系里很突兀。改为「中性 = 静态 / 蓝色 = 正在流式」——",
					"   颜色只表达活跃度、不再表达种类；思考与产出本来就由标题文字区分。",
					"   实测两者 ::before 均为 rgb(173,178,184)。 ── */",
					".dpo-pane-title::before{background:var(--dsw-alias-label-caption,#81858c);opacity:.85}",
					".dpo-pane[data-kind=\"text\"] .dpo-pane-title::before{background:var(--dsw-alias-label-caption,#81858c)}",
					".dpo-pane[data-live=\"true\"] .dpo-pane-title::before{background:var(--dsw-alias-state-business-primary,#4176e6);opacity:1}",
					"/* ── 35) token chip 中性化：client.js:2682 给\"有值\"的 chip 铺了 --dpo-acc 蓝底蓝字，",
					"   但 DSH 只在主操作上用品牌蓝。改中性浅底 + tertiary 文字（实测 7% label-primary",
					"   + rgb(129,133,140)），与 .dpo-tok-muted（client.js:2905，纯文字、无底色）靠有无底色区分；",
					"   .dpo-tok-live（等待用量上报）保留蓝色 —— 它表达的是\"正在工作\"。 ── */",
					".dpo-tok-chip{background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f0f0f) 7%,transparent);color:var(--dsw-alias-label-tertiary,#979da6);border-color:transparent;font-weight:500}",
					".dpo-tok-chip.dpo-tok-muted{background:none;color:var(--dsw-alias-label-caption,#adb2b8)}",
					".dpo-tok-chip.dpo-tok-live{background:var(--dpo-acc-12);color:var(--dpo-acc);border-color:var(--dpo-acc-22)}",
					"/* ── 36) .dpo-overlay-src 无障碍回调：v68（本文件 238 行）为压制它与 .dpo-run-status",
					"   都在报\"档位\"的重复，把它降到 --dsw-alias-label-caption(#adb2b8)，白底对比度仅 ~2.6:1，",
					"   低于 WCAG AA 的 4.5:1，实拍几乎读不出。提到 tertiary(#81858c) ≈3.9:1 至少可读；",
					"   真正的去重（两行都在报档位）要在 JS 层做，属下一轮。 ── */",
					".dpo-overlay-src{color:var(--dsw-alias-label-tertiary,#81858c)}",
					"/* ══════════ v72 · 档位 / 发送：滑块 → 下拉（产品层） ══════════ */",
					"/* 33. 下拉条目右侧的说明文字：位置同 .dpo-pop-chip（.dpo-pop-item 是 flex + margin-left:auto），",
					"   但不带\"会话当前\"那种蓝色实心胶囊底 —— 这里承载的是解释，不是状态徽标。 */",
					".dpo-pop-chip-quiet{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);letter-spacing:0;white-space:nowrap}",
					"/* 34. 档位为「关闭」时发送按钮不可用：降到 45% 但不隐藏（title 仍要能说明原因）。 */",
					".dpo-model[data-off=\"true\"]{opacity:.45;cursor:not-allowed}",
					".dpo-model[data-off=\"true\"]:hover{border-color:var(--dpo-line);background:transparent}",
					"/* 35. 三个按钮的标签列统一为弱化灰：它们和「模型」按钮同构，标签层级应一致（v52 在 <=1080px 隐藏 k）。 */",
					".dpo-controls .dpo-model-k{color:var(--dsw-alias-label-tertiary,#8a8a8a)}",
					"/* ══════════ v73 · 下拉弹层的实拍修正（v72 的后续） ══════════ */",
					"/* 36. 弹层加宽到 368px：原 308px 装不下「选项名 + 说明」，说明被 flex 压掉尾部。 */",
					".dpo-pop[data-dpo=\"tier-pop\"],",
					".dpo-pop[data-dpo=\"perm-pop\"]{width:368px}",
					"/* 37. 说明文字不参与收缩 —— .dpo-pop-item 是 flex，说明默认 flex-shrink:1 会被压扁。 */",
					".dpo-pop-chip-quiet{margin-left:auto;flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap}",
					"/* 38. 高度上限放宽：calc(100vh - 380px) 在 530px 视口下只剩 150px，第 4 项「极端」直接被裁掉。 */",
					".dpo-pop{max-height:min(460px,calc(100vh - 120px))}",
					"/* 39. 选中态左侧品牌色指示条：对齐 DSH 原生下拉的选中表达，比\"整行蓝底\"更克制。",
					"   .dpo-pop-item 已有 position:relative（client.js:2565），故伪元素可绝对定位。 */",
					".dpo-pop-item[data-selected=\"true\"]::before{content:\"\";position:absolute;left:0;top:50%;transform:translateY(-50%);width:2px;height:16px;border-radius:2px;background:var(--dsw-alias-state-business-primary,#4176e6)}",
					"/* ══════════ v74 · 窄屏统一 + 弹层底部操作栏 ══════════ */",
					"/* 40. 弹层底部按钮右对齐紧凑：DSH 原生下拉的底部操作是\"右下角一枚小按钮\"，",
					"   而这里是 flex + 无 justify-content → 按钮拉满整行（368px 宽的条状按钮），",
					"   与原生下拉的视觉重量完全不同。flex:0 0 auto 让它回到内容宽度。",
					"   注意不能影响 .dpo-pop-foot:has(.dpo-btn:nth-child(3)) 那条 grid 规则 ——",
					"   grid 布局下 justify-content 作用于列轨道，1fr 1fr 已占满，故本行对它无副作用。 */",
					".dpo-pop-foot{justify-content:flex-end}",
					".dpo-pop-foot .dpo-btn{flex:0 0 auto;min-width:64px}",
					"/* 41. 「关闭」是弹层里的唯一按钮，位置贴右下；DSH 原生下拉的关闭靠点外部，",
					"   这里保留显式按钮作为兜底。v75f 起已同时支持「点击外部」与「Esc」关闭",
					"   （见 client.js 里 \"下拉弹层：点击外部或按 Esc 收起\" 那个 effect），两者并存不冲突。 */",
					".dpo-pop-foot:has(.dpo-btn:only-child) .dpo-btn{color:var(--dsw-alias-label-secondary,#545557)}",
					"/* ══════════ v76 · 功能层：键盘可达 + 文案单一数据源 ══════════ */",
					"/* 42. 弹层条目的键盘焦点。与 .dpo-model:focus-visible / .dpo-help:focus-visible 同款描边，",
					"   但弹层条目贴边，用负 offset 避免轮廓被弹层裁掉。",
					"   只给轮廓、不给背景：选中项已有 data-selected 的背景与左侧指示条，而",
					"   .dpo-pop-item:focus-visible 与 .dpo-pop-item[data-selected=\"true\"] 同为 0,2,0 特异性，",
					"   若此处再设背景就会与它打架（后写者胜，会让选中态在键盘移动焦点时丢高亮）。 */",
					".dpo-pop-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:-2px}",
					"/* ══════════ v77 · 浮层配色对齐 DSH 原生菜单 ══════════",
					"   依据：第 9 轮 CDP 直取 DSH 原生「选择工作区」菜单的实测值（见 _NOTES.md「DSH 原生菜单实测」）：",
					"     background      rgb(255,255,255)   ← 纯白",
					"     backdrop-filter none               ← 完全不用毛玻璃",
					"     border-radius   20px",
					"     box-shadow      --dsw-elevation-panel（0.5px 发丝 + 极淡柔光）",
					"     border          0px none",
					"     菜单项           高 40px / radius 10px",
					"   插件基线（v77 前实测）：",
					"     bg rgb(233,236,242) / backdrop blur(18px) saturate(1.3) / radius 12px / 项 h33 radius8",
					"   ⚠️ 重要结论：--dsw-alias-bg-overlay = #e9ecf2 虽然真实存在于 DSH，",
					"   但原生菜单是纯白 —— 不要拿它当浮层底色。 */",
					"/* 77-1 背景改纯白。",
					"   插件原走 --dpo-surface(=--dsw-specific-tip=#f5f6f7) 的 color-mix(… 86%, transparent)，",
					"   叠上毛玻璃后在浅色主题下算出 #e9ecf2（灰蓝），与 DSH 原生菜单明显不同色。 */",
					".dpo-pop{background:var(--dsw-alias-bg-layer-1,#fff)}",
					"/* 77-2 去掉毛玻璃。",
					"   DSH 实测 backdrop-filter: none。v51 的 @supports(backdrop-filter) 分支给 .dpo-pop 加了",
					"   blur(18px) saturate(1.3)、给 .dpo-overlay 加了 blur(16px) saturate(1.2)。",
					"   毛玻璃会让 DSH 的 --dsw-elevation-panel 0.5px 发丝描边失去\"贴面\"感（模糊的底透上来）。 */",
					".dpo-pop,.dpo-overlay{backdrop-filter:none}",
					"@supports (backdrop-filter: blur(1px)){",
					"  .dpo-pop,.dpo-overlay{background:var(--dsw-alias-bg-layer-1,#fff);backdrop-filter:none}",
					"}",
					"/* 77-3 圆角 12px → 20px（DSH 菜单容器实测值）。",
					"   只改 .dpo-pop：.dpo-overlay 是大面积浮窗面板，没有可测的 DSH 对应物，不臆测其圆角。 */",
					".dpo-pop{border-radius:20px}",
					"/* 77-4 菜单项几何向 DSH 靠。",
					"   DSH 项是 40px 高 / radius 10px；插件 33px / 8px。",
					"   注意 DSH 的 40px 是\"图标 + 两行文字\"的行高，插件是单行文字，",
					"   所以不是把高度硬拉到 40，而是把 padding 由 8px 提到 11px 让行高落到 39px 附近。 */",
					".dpo-pop-item{padding:11px 12px;border-radius:10px}",
					"/* ══════════ v79 · 迷你浮窗（.dpo-overlay）对齐 DSH ══════════",
					"   依据全部来自 _v79_probe.js 在真实 DSH 页面里的清洁量测（800x530，已杀入场动画）。 */",
					"/* ── 79-1 ★ 修 v67 引入的头部 grid 列映射错乱 ──",
					"   现状（_dpo_v60.css:220-224）: grid-template-columns:auto auto 1fr auto",
					"     ::before(1)  标题(2)  .dpo-head-hint(3)  .dpo-x(4)",
					"   —— 而 DOM 顺序是 [button.dpo-x][span 标题][span.dpo-head-hint]。",
					"   显式 grid-column 把「‹ 回退」甩到最右列，实测列宽 6px / 113.95px / 282.97px / 55.08px，",
					"   视觉为「● 提示词优化·已拦截 ……… ↘可改大小 ‹回退」，三个元素全挤右侧，",
					"   回退按钮从左上角跑到了右上角。",
					"   改为 1fr auto 1fr：左右两列等分剩余空间（左列最小 6px 圆点与 14px+55px 回退按钮的并集=69px，",
					"   右列最小 58px hint），标题列 auto 落位正是容器水平中心。",
					"   推算：容器内容宽 488，减标题 114 与两个 10px gap 得 354，两 1fr 各 177（≥ 各自最小值），",
					"   标题列起于 16+177+10=203、止于 317，中心 260 —— 恰为浮窗 520px 的一半。 */",
					".dpo-overlay-head{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;column-gap:10px}",
					".dpo-overlay-head::before{grid-column:1;grid-row:1;justify-self:start;margin-right:0;width:6px;height:6px}",
					".dpo-overlay-head > .dpo-x{grid-column:1;grid-row:1;justify-self:start;margin-left:14px}",
					".dpo-overlay-head > span:not(.dpo-head-hint){grid-column:2;grid-row:1;justify-self:center;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
					".dpo-overlay-head > .dpo-head-hint{grid-column:3;grid-row:1;justify-self:end}",
					"/* ── 79-2 头部下边线改用 DSH 自己的分隔线写法 ──",
					"   DSH 的 dsh-client-ui-theme 设置行用 border-bottom:.5px solid var(--dsw-alias-border-l2)；",
					"   插件原为 1px color-mix(in srgb,var(--dpo-line) 70%,transparent)，实测 color(srgb 0 0 0 / 0.0713725)",
					"   —— 即 10%(=border-l2) × 0.7 = 7.14%，且 1px 比 DSH 的 0.5px 重一倍。 */",
					".dpo-overlay-head{border-bottom:.5px solid var(--dsw-alias-border-l2,#0000001a)}",
					"/* ── 79-3 .dpo-pane 补 box-sizing:border-box ──",
					"   client.js:2771 @media (max-height:640px){.dpo-pane{max-height:min(132px,22vh)}}",
					"   意图是「pane 至多 132px 高」，但默认 content-box 下 116.6px 只是内容高，",
					"   加 padding 11px×2 与 border 1px×2 后实测 offsetHeight 136px —— 比意图高 19px。",
					"   （同族 .dpo-pop 早在 _dpo_v60.css:183 就补了 box-sizing:border-box，pane 漏了。） */",
					".dpo-pane{box-sizing:border-box}",
					"/* ── 79-4 token 徽标改用 DSH 的语义叠色 ──",
					"   原 _dpo_v60.css:330 用 color-mix(in srgb,var(--dsw-alias-label-primary,#0f0f0f) 7%,transparent)",
					"   —— 拿「文字色」当背景色。DSH 的 --dsw-alias-interactive-bg-hover = #2631480f（深蓝灰 6%）",
					"   正是给这类浅底叠色用的语义 token。 */",
					".dpo-tok-chip{background:var(--dsw-alias-interactive-bg-hover,#2631480f)}",
					"/* ══════════ v81 · 模型弹层宽度对齐 ══════════ */",
					"/* 81-1. model-pop 补足到 368px，与 tier-pop / perm-pop 对齐。",
					"   实测（headless 1264x630，computed width）：",
					"     tier-pop 368 / perm-pop 368 / help-pop 396 / model-pop 308 ← 唯一用基础值的",
					"   基础链是 client.js:2542 258px → :2650 272px → :2756 308px；:3099 只给 perm-pop 设了 368。",
					"   308px 下底部「恢复默认（跟随会话）」按钮几乎占满整行。",
					"   选 368 而非给四个弹层定新值：368 是既有既定值，且模型名与分组名在 368 下留白舒适。",
					"   help-pop 的 396px 是 13 行帮助文档的内容需要，保持不变。 */",
					".dpo-pop[data-dpo=\"model-pop\"]{width:368px}",
					"/* ══════════ v82 · 帮助弹层去蓝 ══════════ */",
					"/* 82-1. .dpo-help-k 去蓝。",
					"   client.js:2792 原为 .dpo-help-k{flex:0 0 62px;color:var(--dpo-acc);font-weight:600}",
					"   —— 硬编码品牌蓝 + 600 字重。实测量测（headless 1264x630，getComputedStyle）：",
					"     改前 kColor rgb(65,118,230) / w600，一屏 13 行里 9 行是蓝的（①②③ 与四个档位名、发送方式名）。",
					"   DSH 的设计语言是「行标题 primary / 说明 secondary / 分组标题 caption」的灰阶层级，",
					"   彩色只给主操作。这里改为 label-primary + 500，与 .dpo-help-v(label-secondary) 形成正确层级。 */",
					".dpo-help-k{color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:500}",
					"/* 82-2. .dpo-help-tip 断行与字重。",
					"   client.js:2794 的 tip 是 font-weight:600 + 蓝底蓝边，偏重；且实测文案 30 字在 340px 内容宽下",
					"   换行成「…建议【自 / 动】。」，末行只剩一个孤字。text-wrap:pretty 让浏览器避免孤行。 */",
					".dpo-help-tip{font-weight:500;text-wrap:pretty}",
					"/* ══════════ v83 · 滚动区不被压缩 + 查证动作去蓝 ══════════ */",
					"/* 83-1 ★ 真 bug：.dpo-overlay-scroll 是 flex column（client.js:2556），其直接子项",
					"   默认 flex-shrink:1。done 态内容溢出（scrollHeight 534 > clientHeight 393）时，",
					"   .dpo-trace 被压到 offsetHeight:1 —— 只剩 1px 的 border-top，8 行查证动作",
					"   rowsVisible:0，用户一条都看不见。它自带 overflow:auto，本应固定高再内部滚动。",
					"   作者已给 .dpo-overlay-foot 加 flex:0 0 auto（client.js:2768），但滚动区子项全漏了。",
					"   让全部直接子项保持内容高度，溢出交给滚动区处理。 */",
					".dpo-overlay-scroll > *{flex:0 0 auto}",
					"/* 83-2 工具名原为品牌蓝（client.js:2580 var(--dsw-alias-state-business-primary)），",
					"   与 v82 修掉的 .dpo-help-k 同类：彩色只给主操作；等宽字本身已足够区分。 */",
					".dpo-trace-tool{color:var(--dsw-alias-label-secondary,#61666b)}",
					"/* 83-3 .dpo-trace-row 不可点击（无 onClick、无 role），却带蓝色 hover 背景",
					"   （client.js:2707 background:var(--dpo-acc-12)）—— 虚假可交互暗示，去掉。 */",
					".dpo-trace-row:hover{background:none}",
					"/* ══════════ v84 · 控件行胶囊逐属性对齐 DSH composer ══════════ */",
					"/* 84-1 尺寸：DSH composer 胶囊实测 height:28px（deepseek-flash / 完全权限 / 标准模式",
					"   三者一致），插件是 30px。.dpo-help 同步 30→28 以保持同一基线。 */",
					".dpo-controls .dpo-model{height:28px}",
					".dpo-controls .dpo-help{width:28px;height:28px}",
					"/* 84-2 ★ 圆角：v66 第 21 条把 .dpo-model 设成 border-radius:8px，理由写的是",
					"   「DSH 的 8px 圆角尺度」—— 但那个尺度属于弹层内条目（.dpo-pop-item）。",
					"   composer 胶囊实测是 24px（带箭头的 deepseek-flash / 完全权限）或 16px",
					"   （纯文字的标准模式）。插件三个按钮都带 ▾，取 24px。 */",
					".dpo-controls .dpo-model{border-radius:24px}",
					"/* 84-3 字号与字重：DSH 全部 13px / 500，插件是 12px / 400。 */",
					".dpo-controls .dpo-model{font-size:13px;font-weight:500}",
					"/* 84-4 内边距：DSH 带箭头胶囊是左 8px、右 4px（右侧留出箭头空间）；",
					"   插件原为 11px/11px。 */",
					".dpo-controls .dpo-model{padding:0 4px 0 8px}",
					"/* 84-5 边框占位：DSH 全部 border-width:0px，插件留了 1px 透明边框。",
					"   border-box 下不改变尺寸，但会让可点区域与描边基准多 2px，归零。 */",
					".dpo-controls .dpo-model,",
					".dpo-controls .dpo-help{border-width:0}",
					"/* 84-6 标签与箭头：DSH 的副标签（deepseek-flash 的 \"Max\"）与主标签同字号 13px，",
					"   只靠颜色 tertiary 区分；插件 .dpo-model-k（「档位」）是 11px，小 2px。",
					"   箭头在 DSH 是 tertiary 色的 svg，插件是 9px 的文字 ▾（过小且偏深）。 */",
					".dpo-controls .dpo-model-k{font-size:13px}",
					".dpo-controls .dpo-model-caret{font-size:11px;color:var(--dsw-alias-label-caption,#81858c)}",
					"/* 84-7 内部间距：DSH 胶囊 gap 实测 4px，插件 5px。 */",
					".dpo-controls .dpo-model{gap:4px}",
					"/* 84-8 「?」按钮的字重跟随：DSH 图标控件统一 500，插件原为 600。 */",
					".dpo-controls .dpo-help{font-weight:500}",
					"/* ══════════ v86 · 下拉箭头复刻 DSH 官方 chevron（1:1） ══════════",
					"   实测：DSH 全站下拉共用同一个图标 —— pXSMma_chevron / cubgiG_chevron / _7KE1Ra_chevron /",
					"   Sh0Q9G_chevron，全部 width=14 height=14 viewBox=\"0 0 14 14\" + 同一条 path（624 字符）。",
					"   插件原来用文字 \"▾\"：9.2x15、opacity .6、font-size 11px —— 形状（实心三角 vs 描边 V）、",
					"   尺寸（9.2 vs 14）、视觉重量（半透明 vs 满不透明）三者都不一致，截图里几乎看不到箭头。",
					"   此处用 mask-image 复刻：mask 走 alpha 通道，故 background-color:currentColor 仍能让",
					"   箭头颜色跟随主题（data URI 内无法引用 currentColor，直接填色会在暗色主题下失配）。",
					"   font-size:0 用于隐藏原文字 \"▾\"，不影响子元素（caret 内没有子元素）。 */",
					".dpo-controls .dpo-model-caret{width:14px;height:14px;font-size:0;flex:0 0 auto;opacity:1;background-color:currentColor;-webkit-mask-image:url(\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='14'%20height='14'%20viewBox='0%200%2014%2014'%20fill='none'%3E%3Cpath%20d='M11.8486%205.5L11.4238%205.92383L8.69727%208.65137C8.44157%208.90706%208.21562%209.13382%208.01172%209.29785C7.79912%209.46883%207.55595%209.61756%207.25%209.66602C7.08435%209.69222%206.91565%209.69222%206.75%209.66602C6.44405%209.61756%206.20088%209.46883%205.98828%209.29785C5.78438%209.13382%205.55843%208.90706%205.30273%208.65137L2.57617%205.92383L2.15137%205.5L3%204.65137L3.42383%205.07617L6.15137%207.80273C6.42595%208.07732%206.59876%208.24849%206.74023%208.3623C6.87291%208.46904%206.92272%208.47813%206.9375%208.48047C6.97895%208.48703%207.02105%208.48703%207.0625%208.48047C7.07728%208.47813%207.12709%208.46904%207.25977%208.3623C7.40124%208.24849%207.57405%208.07732%207.84863%207.80273L10.5762%205.07617L11%204.65137L11.8486%205.5Z'%20fill='%23000'/%3E%3C/svg%3E\");mask-image:url(\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='14'%20height='14'%20viewBox='0%200%2014%2014'%20fill='none'%3E%3Cpath%20d='M11.8486%205.5L11.4238%205.92383L8.69727%208.65137C8.44157%208.90706%208.21562%209.13382%208.01172%209.29785C7.79912%209.46883%207.55595%209.61756%207.25%209.66602C7.08435%209.69222%206.91565%209.69222%206.75%209.66602C6.44405%209.61756%206.20088%209.46883%205.98828%209.29785C5.78438%209.13382%205.55843%208.90706%205.30273%208.65137L2.57617%205.92383L2.15137%205.5L3%204.65137L3.42383%205.07617L6.15137%207.80273C6.42595%208.07732%206.59876%208.24849%206.74023%208.3623C6.87291%208.46904%206.92272%208.47813%206.9375%208.48047C6.97895%208.48703%207.02105%208.48703%207.0625%208.48047C7.07728%208.47813%207.12709%208.46904%207.25977%208.3623C7.40124%208.24849%207.57405%208.07732%207.84863%207.80273L10.5762%205.07617L11%204.65137L11.8486%205.5Z'%20fill='%23000'/%3E%3C/svg%3E\");-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;-webkit-mask-size:14px 14px;mask-size:14px 14px}",
					"/* ══════════ v87 · 浮窗信息层级：结果与操作先于过程 ══════════",
					"   实测 regen 态：.dpo-overlay-scroll 的五个直接子项依次是",
					"     .dpo-overlay-src(32) .dpo-run(295) .dpo-review(302) .dpo-overlay-body(45) .dpo-trace(73)",
					"   scrollHeight 746 vs clientHeight 387 —— 核心操作区 .dpo-review 被 295px 的过程 pane 推到视口下方。",
					"   容器已是 flex column，用 order 重排为「元信息 → 结果与操作 → 思考/产出 → 查证 → 原文摘要」。",
					"   纯 CSS，不改 DOM 顺序（键盘 Tab 顺序仍是原顺序，但本浮窗以视觉导航为主）。 */",
					".dpo-overlay-scroll > .dpo-overlay-src{order:1}",
					".dpo-overlay-scroll > .dpo-review{order:2}",
					".dpo-overlay-scroll > .dpo-run{order:3}",
					".dpo-overlay-scroll > .dpo-trace{order:4}",
					".dpo-overlay-scroll > .dpo-overlay-body{order:5}",
					"/* ══════════ v88 · 检查后提交：标题回归它命名的内容 ══════════",
					"   regen 态下 .dpo-review 的子元素顺序为 [检查后提交标题][方向面板][产出 textarea]，",
					"   导致标题与产出分离、两个 pane-title 连排。容器是 flex column，用 order 调整为",
					"   方向面板 → 检查后提交标题 → 产出 textarea，使每个标题都紧贴自己命名的内容。",
					"   非 regen 态无 .dpo-regen-ask，剩余两项的相对顺序不受影响。 */",
					".dpo-review > .dpo-regen-ask{order:1}",
					".dpo-review > .dpo-pane-title{order:2}",
					".dpo-review > .dpo-review-text{order:3}",
					"/* ══════════ v93 · 矮视口下 .dpo-trace 的可读性 ══════════ */",
					"/* v51 把 .dpo-trace-head 的 padding 从 4px 10px 放大到 7px 16px（实测 24px→29px），",
					"   把 .dpo-trace-row 从 2px 10px 放大到 4px 16px（实测 19px→23px），",
					"   并把 .dpo-trace 的 max-height 从 92px 提到 120px —— 同步了。",
					"   但 client.js:2770 的 @media (max-height:640px){.dpo-trace{max-height:72px}}",
					"   仍按旧尺寸（head 24 + 2×19 = 62）估的，漏了同步：",
					"   630 高视口下 head 独占 29px，剩 43px 恰好只容 1 行完整可见。",
					"   实测 72px→150px 后 rowsFullyVisible 由 1 变 5，且滚动区 clientH 不变 387",
					"   （.dpo-trace 是 .dpo-overlay-scroll 的 order:4 末项，加高不挤压其它内容）。 */",
					"@media (max-height:640px){.dpo-trace{max-height:min(150px,26vh)}}",
					"/* 滚动时保持标题可见：原先滚下去就看不到「查证动作 N 步」这行，不知道在翻什么。",
					"   背景取 --dsw-alias-bg-layer-1，与 v77 起浮窗自身底色一致，滚动时自然遮住下方行。 */",
					".dpo-trace-head{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-1,#fff)}",
					"/* ══════════ v96 · done 态隐藏与 textarea 重复的「产出」pane ══════════ */",
					"/* 依据：.dpo-pane[data-dpo=\"pane-text\"] 渲染 run.text；",
					"   reviewPane()（client.js:914-917）渲染 (store.reviewText !== undefined && store.reviewText !== null) ? store.reviewText : run.text。",
					"   初始时两者逐字相同，done 态下同一屏幕上出现两份相同文本。",
					"   只在 [data-state=\"done\"] 隐藏：run 态没有 textarea（reviewPane 仅在 done 时返回），",
					"   error 态也没有，那时「产出」pane 是唯一的产出出口，必须保留。",
					"   实测（630 视口、regen/done 态）：.dpo-run 294.71px → 150.66px，",
					"   .dpo-overlay-scroll scrollH 824 → 680，首屏 textarea 仍完全可见（126px）、",
					"   .dpo-overlay-foot 的 top 482 恰等于滚动区 bottom 482（无缝贴合）。 */",
					".dpo-overlay[data-state=\"done\"] .dpo-pane[data-dpo=\"pane-text\"]{display:none}",
					"/* ══════════ v97 · 「你的原文」：补标题 + 让原文在 done 态可见 ══════════",
					"   v87 用 order 把滚动区排成「元信息 → 结果与操作 → 思考/产出 → 查证 → 原文摘要」，",
					"   order:5 本就是留给原文的。但 .dpo-overlay-body 直接渲染 o.text、没有任何标题，",
					"   done 态又沿用 run 态写入的前 80 字 —— 用户看到的是「无标题、无说明、半截的片段」。",
					"   v94 的处理是清空 text（方向错了）；v97 改为：补标题 + 写完整原文（由 JS 侧 v97a–d 完成），",
					"   CSS 侧只需把包层后的 order 重新指向 .dpo-orig，并给正文一个高度上限。 */",
					".dpo-overlay-scroll > .dpo-orig{order:5}",
					".dpo-orig{margin-top:2px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,#0000000a)}",
					".dpo-orig .dpo-overlay-body{max-height:120px;overflow:auto;box-sizing:border-box}",
					"/* ══════════ v98 · 长内容压力测试后的两处修正 ══════════",
					"   压力测试（_v98_stress.js）灌入 834 字原文 + 1201px 思考内容后实测：",
					"     1) .dpo-pane 是 overflow:auto、max-height:132px，超长思考被从半行处硬切 ——",
					"        截图上看起来像渲染坏了。加底部渐隐，提示「下面还有内容」。",
					"        用 mask-image 而不是 ::after：绝对定位的伪元素在滚动容器里会随内容滚动，",
					"        而 mask 作用在元素自身的可视区域上，不随内容滚动。",
					"     2) .dpo-orig .dpo-overlay-body 的 max-height:120px 只能看 4~5 行，",
					"        对「优化前后对比」这个用途太紧；改用 min(50vh,360px)（覆盖 v97 段里的 120px）。",
					"   复测：paneOffH 132 不变、origMaxH 315px、origOffH 315、scrollH 711 → 906。 */",
					".dpo-pane{position:relative;-webkit-mask-image:linear-gradient(180deg,#000 0,#000 calc(100% - 26px),transparent 100%);mask-image:linear-gradient(180deg,#000 0,#000 calc(100% - 26px),transparent 100%)}",
					".dpo-orig .dpo-overlay-body{max-height:min(50vh,360px)}",
					"/* ══════════ v99 · 优化结果复制 ══════════ */",
					"/* 99-1. 优化结果「复制」按钮。",
					"   margin-left:auto 顶到标题行尾；不用 justify-content:space-between ——",
					"   .dpo-pane-title 是 [::before 圆点][文字] 的 flex 容器，space-between 会把文字推到中间。",
					"   无边框 + tertiary 起始色：与 DSH 控件语言一致（默认无边框无底色，hover 才浮出浅灰底）；",
					"   复制成功时用品牌色 12% 底 + 品牌色字反馈，1.4s 后自动还原。",
					"   颜色全部走 DSH 语义 token，无硬编码。 */",
					".dpo-copy{margin-left:auto;flex:0 0 auto;font:inherit;font-size:11px;line-height:1;padding:4px 10px;border-radius:999px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer;white-space:nowrap;transition:background .15s,color .15s}",
					".dpo-copy:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}",
					".dpo-copy:active{transform:translateY(1px)}",
					".dpo-copy[data-copied=\"1\"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 12%,transparent);color:var(--dsw-alias-state-business-primary,#4176e6)}",
					".dpo-copy:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px}",
					"",
					"/* ══════════ v101 · 原文紧跟结果（优化前后可同屏对照） ══════════ */",
					".dpo-overlay-scroll > .dpo-orig{order:3}",
					".dpo-overlay-scroll > .dpo-run{order:4}",
					".dpo-overlay-scroll > .dpo-trace{order:5}",
					".dpo-blocked{padding:8px 16px;font-size:11.5px;line-height:1.5;text-wrap:pretty;color:var(--dsw-alias-state-business-primary,#4176e6);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 8%,transparent);border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 20%,transparent)}",
					"",
					"/* ══════════ v107 · 拦截提示不挤压控件行（改绝对定位浮层） ══════════ */",
					".dpo-controls{position:relative}",
					".dpo-controls .dpo-notice{position:absolute;left:0;bottom:calc(100% + 8px);z-index:30;flex:0 0 auto;max-width:min(440px,72vw);white-space:normal;text-wrap:pretty}",
					"/* ══════════ v110 · 跟随 DSH 内容字号 ══════════ */",
					"/* 真机实测：--dsh-content-font-size 在 body 上为 15px（用户已调大），插件内容区却恒为 13px；把 token 改到 22px 后 delta 立即由 calc(15px - 14px) 变为 calc(22px - 14px)，证明 delta 是活的。DSH 自身文字链即 calc(21px + var(--dsh-content-font-delta)) 写法。★ 边界：DSH 的 composer 胶囊在 15px 与 22px 下均为 13px —— 它自己就不让控件跟随，故 .dpo-controls 保持固定，仅浮窗/弹层的阅读区跟随。 */",
					".dpo-pop,.dpo-overlay{--dpo-fs-1:calc(12px + var(--dsh-content-font-delta,0px));--dpo-fs-2:calc(13px + var(--dsh-content-font-delta,0px));--dpo-fs-3:calc(11.5px + var(--dsh-content-font-delta,0px))}",
					".dpo-pane-title,.dpo-overlay-src,.dpo-run-status,.dpo-trace-head,.dpo-trace-tool,.dpo-trace-empty,.dpo-run-error,.dpo-pop-gtitle,.dpo-help-sec,.dpo-blocked{font-size:calc(11.5px + var(--dsh-content-font-delta,0px))}",
					".dpo-review .dpo-pane-title,.dpo-regen-ask .dpo-pane-title,.dpo-pop-head,.dpo-pop-empty,.dpo-help-row{font-size:calc(12px + var(--dsh-content-font-delta,0px))}",
					".dpo-help-tip{font-size:calc(12.5px + var(--dsh-content-font-delta,0px))}",
					".dpo-head-hint,.dpo-pop-chip-quiet,.dpo-copy,.dpo-x,.dpo-tok-chip.dpo-tok-muted{font-size:calc(11px + var(--dsh-content-font-delta,0px))}",
					".dpo-pop-chip,.dpo-tok-chip,.dpo-hint-quiet,.dpo-help-meta{font-size:calc(10.5px + var(--dsh-content-font-delta,0px))}",
									"/* ══════════ v112 · 弹层横向不超出视口 ══════════ */",
					"/* 定位常量已按实际宽度修正（368/396 + 8 边距），此处是第二道防线：",
					"   即便将来弹层宽度再变，max-width 也保证不会横向溢出视口。 */",
					".dpo-pop{max-width:calc(100vw - 16px)}",
				].join("\n");
				document.head.appendChild(style);
				return () => { style.remove(); };
			}, NS + ": styles");

			own(() => ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "prompt-optimizer",
				order: 20,
			}, Controls)), NS + ": composer controls");

			// 自愈：HMR 拆卸竞态后若控件没挂上，延时重挂一次（防"UI 全消失"）
			own(() => {
				let tries = 0;
				const timer = window.setInterval(() => {
					tries += 1;
					if (document.querySelector('[data-dpo="controls"]')) {
						if (tries > 1) beacon("controls-healed", { tries });
						window.clearInterval(timer);
						return;
					}
					beacon("remount-controls", { tries });
					own(() => ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
						name: "conversation.input.left", id: "prompt-optimizer", order: 20,
					}, Controls)), NS + ": composer controls (retry " + tries + ")");
					if (tries >= 8) {
						beacon("remount-give-up", { tries });
						window.clearInterval(timer);
					}
				}, 1200);
				return () => window.clearInterval(timer);
			}, NS + ": controls self-heal (repeating)");
			own(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "prompt-optimizer-overlay",
				order: 60,
			}, OverlayHost)), NS + ": placeholder overlay");
			// 浮层自愈：store 说"开着"但 DOM 里没有节点 → 重挂一次（防"弹窗无声消失"）
			own(() => {
				let tries = 0;
				const timer = window.setInterval(() => {
					tries += 1;
					if (!store.overlay.open) { if (tries > 1) window.clearInterval(timer); return; }
					if (document.querySelector('[data-dpo="overlay"]')) {
						if (tries > 1) { beacon("overlay-healed", { tries }); window.clearInterval(timer); }
						return;
					}
					beacon("remount-overlay", { tries, runStatus: store.run ? store.run.status : null, tier: store.tier });
					own(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
						name: "shell.overlay", id: "prompt-optimizer-overlay", order: 60,
					}, OverlayHost)), NS + ": overlay retry " + tries);
					if (tries >= 6) { beacon("overlay-slot-missing", { tries }); window.clearInterval(timer); }
				}, 1500);
				return () => window.clearInterval(timer);
			}, NS + ": overlay self-heal");
			// 全局异常埋点：任何未捕获错误/拒绝都留痕（浮层消失类问题的最后一层证据）
			own(() => {
				const onErr = (e) => beacon("client-error", {
					message: String((e && (e.message || e.error)) || "").slice(0, 300),
					stack: String((e && e.error && e.error.stack) || "").slice(0, 700),
					source: String((e && e.filename) || "").slice(0, 140), line: (e && e.lineno) || null,
				});
				const onRej = (e) => beacon("client-rejection", { reason: String((e && e.reason && (e.reason.stack || e.reason.message)) || (e && e.reason) || "").slice(0, 700) });
				window.addEventListener("error", onErr);
				window.addEventListener("unhandledrejection", onRej);
				return () => { window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onRej); };
			}, NS + ": error beacons");

			// 探针触发：轮询 host 命令通道（evidence/cmd.json），token 变化即跑一轮
			let lastToken = window.__DPO_LAST_TOKEN__ || null;
			own(() => {
				const t = window.setInterval(() => {
					fetch(API + "/trace", { cache: "no-store" }).then((r) => r.json()).then((d) => {
						store.trace = d && d.ok ? d : null;
						emit();
					}).catch(() => { /* best effort */ });
				}, 3000);
				return () => window.clearInterval(t);
			}, NS + ": trace poll");
			own(() => {
				const timer = window.setInterval(() => {
					fetch(API + "/cmd", { cache: "no-store" })
						.then((r) => r.json())
						.then((d) => {
							const cmd = d && d.cmd;
							if (!cmd || !cmd.run || !cmd.token || cmd.token === lastToken) return;
							if (window.__DPO_PROBE_RUNNING__ === true) return;
							// 模型弹层自检（宿主下发）：打开弹层 → 数一遍真实渲染出来的条目 → 关闭
							if (cmd.run === "popover-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								const popT0 = Date.now();
								store.modelPop = { x: 200, bottom: 260, maxH: 420 };
								store.modelPopOpen = true;
								emit();
								window.setTimeout(() => {
									const pop = document.querySelector('[data-dpo="model-pop"]');
									const r = pop ? pop.getBoundingClientRect() : null;
									beacon("popover-demo", {
										open: Boolean(pop),
										items: document.querySelectorAll('[data-dpo="model-item"]').length,
										groups: document.querySelectorAll('[data-dpo="model-group"]').length,
										loading: Boolean(document.querySelector('[data-dpo="model-loading"]')),
										error: Boolean(document.querySelector('[data-dpo="model-error"]')),
										catalogLoading: store.modelCatalogLoading === true,
										catalogAgeMs: store.modelCatalogAt ? Date.now() - store.modelCatalogAt : null,
										rect: r ? { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
										viewport: { w: window.innerWidth, h: window.innerHeight },
										inView: Boolean(r) && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
										scrollH: pop ? pop.scrollHeight : null, clientH: pop ? pop.clientHeight : null,
										elapsedMs: Date.now() - popT0,
										firstItemText: (() => { const el = document.querySelector('[data-dpo="model-item"]'); return el ? String(el.textContent).slice(0, 40) : null; })(),
										// v51：胶囊状态 + 选中/会话高亮 + 动效是否生效
										pillOpen: (() => { const el = document.querySelector('[data-dpo="model"]'); return el ? el.getAttribute("data-open") : null; })(),
										selectedCount: document.querySelectorAll('[data-dpo="model-item"][data-selected="true"]').length,
										sessionCount: document.querySelectorAll('[data-dpo="model-item"][data-session="true"]').length,
										sessionChips: document.querySelectorAll(".dpo-pop-chip").length,
										popAnim: pop ? getComputedStyle(pop).animationName : null,
										popBlur: pop ? (getComputedStyle(pop).backdropFilter || getComputedStyle(pop).webkitBackdropFilter || null) : null,
									});
									store.modelPopOpen = false;
									emit();
								}, 900);
								return;
							}
							// 端到端自检（宿主下发）：跑一次真优化，只允许在「审查」发送方式下进行 —— 绝不发送消息
							if (cmd.run === "run-demo") {
								if (store.permission !== "review") { beacon("run-demo-refused", { permission: store.permission }); lastToken = cmd.token; return; }
								if (store.run && (store.run.status === "connecting" || store.run.status === "running")) { beacon("run-demo-deferred", { status: store.run.status }); return; }
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								beacon("run-demo-start", { token: cmd.token, tier: cmd.tier || "basic", permission: store.permission });
								startRun(String(cmd.text || "（自检）把那个页面弄好看点"), cmd.tier || "basic", false);
								const t = window.setInterval(() => {
									if (store.run && store.run.status !== "connecting" && store.run.status !== "running") {
										window.clearInterval(t);
										window.setTimeout(() => {
											beaconOverlayGeom("run-demo-done");
											beacon("run-demo-ui", {
												status: store.run ? store.run.status : null,
												chars: store.run ? String(store.run.text || "").length : 0,
												hasReviewText: Boolean(document.querySelector('[data-dpo="review-text"]')),
												hasConfirm: Boolean(document.querySelector('[data-dpo="confirm"]')),
												hasRegen: Boolean(document.querySelector('[data-dpo="regen"]')),
												hasRollback: Boolean(document.querySelector('[data-dpo="rollback"]')),
												hasGrip: Boolean(document.querySelector('[data-dpo="resize"]')),
												hasFoot: Boolean(document.querySelector('[data-dpo="overlay-foot"]')),
												footButtons: Array.from(document.querySelectorAll('[data-dpo="overlay-foot"] button')).map((b) => b.getAttribute("data-dpo")),
												footInView: (() => { const el = document.querySelector('[data-dpo="overlay-foot"]'); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1; })(),
												tokReasoning: (() => { const el = document.querySelector('[data-dpo="token-reasoning"]'); return el ? String(el.textContent) : null; })(),
												tokNone: Boolean(document.querySelector('[data-dpo="token-reasoning-none"]')),
												tokTotal: (() => { const el = document.querySelector('[data-dpo="token-total"]'); return el ? String(el.textContent) : null; })(),
												usage: store.run && store.run.usage ? Object.keys(store.run.usage).slice(0, 12) : null,
											});
											// 自检收尾：不留浮层、不留运行（演示不产生任何用户可见残留）
											store.run = null;
											store.reviewText = null;
											setOverlay({ open: false });
											beacon("run-demo-end", {});
										}, 200);
									}
								}, 400);
								return;
							}
							// 使用帮助自检（宿主下发）：打开帮助面板 → 数条目/查推荐语 → 关闭
							if (cmd.run === "help-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								const hb = document.querySelector('[data-dpo="help"]');
								const r0 = hb ? hb.getBoundingClientRect() : null;
								store.helpPos = r0 ? { x: Math.max(8, Math.min(r0.left - 260, window.innerWidth - 404)), bottom: Math.max(8, window.innerHeight - r0.top + 6), maxH: Math.max(200, r0.top - 16) } : { x: 200, bottom: 260, maxH: 420 };
								store.helpOpen = true;
								emit();
								window.setTimeout(() => {
									const pop = document.querySelector('[data-dpo="help-pop"]');
									const r = pop ? pop.getBoundingClientRect() : null;
									beacon("help-demo", {
										button: Boolean(hb),
										open: Boolean(pop),
										rows: document.querySelectorAll('.dpo-help-row').length,
										sections: document.querySelectorAll('.dpo-help-sec').length,
										tip: (() => { const el = document.querySelector('[data-dpo="help-tip"]'); return el ? String(el.textContent).trim() : null; })(),
										meta: (() => { const el = document.querySelector('[data-dpo="help-meta"]'); return el ? String(el.textContent).trim() : null; })(),
										rect: r ? { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
										inView: Boolean(r) && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
										scrollH: pop ? pop.scrollHeight : null, clientH: pop ? pop.clientHeight : null,
									});
									store.helpOpen = false;
									emit();
								}, 500);
								return;
							}
							// 档位/权限按会话独立 自检（宿主下发）：A 改 → 切 B 改 → 切回 A 应保持 A 的值
							if (cmd.run === "tier-session-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								const realSid = store.viewSessionId;
								const t0 = store.tier;
								const p0 = store.permission;
								const other = "__dpo_other_session__";
								setTier(t0 === "advanced" ? "extreme" : "advanced", "ui");
								const tierA = store.tier;
								const permA = store.permission;
								window.setTimeout(() => {
									onViewSessionChange(other);
									setTier("off", "ui");
									const permB0 = store.permission;
									window.setTimeout(() => {
										const bState = { tier: store.tier, permission: permB0, sessionId: store.viewSessionId };
										onViewSessionChange(realSid);
										window.setTimeout(() => {
											const backA = { tier: store.tier, permission: store.permission, sessionId: store.viewSessionId };
											beacon("tier-session-demo", {
												realSid, other,
												a: { tier: tierA, permission: permA },
												b: bState,
												backA,
												pass: bState.tier === "off" && backA.sessionId === realSid && backA.tier === tierA && tierA !== "off",
												mapKeys: Object.keys(store.tierBySession).length,
											});
											// 还原用户原值
											store.tierBySession[realSid] = t0;
											store.permissionBySession[realSid] = p0;
											setTier(t0, "probe-restore");
											if (p0 !== store.permission) setPermission(p0, "probe-restore");
											emit();
										}, 260);
									}, 260);
								}, 260);
								return;
							}
							// 改尺寸自检（宿主下发）：验手柄没被底栏盖住 + 拖拽真的改变尺寸
							if (cmd.run === "resize-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								const keepSize = store.overlaySize ? Object.assign({}, store.overlaySize) : null;
								store.suppressUiPersist = true;
								setOverlay({ open: true, text: "改尺寸自检", fullText: "", src: "demo", sessionId: store.viewSessionId });
								emit();
								window.setTimeout(() => {
									const panel = document.querySelector('[data-dpo="overlay"]');
									const grip = document.querySelector('[data-dpo="resize"]');
									const r0 = panel ? panel.getBoundingClientRect() : null;
									const g = grip ? grip.getBoundingClientRect() : null;
									const hit = g ? document.elementFromPoint(Math.round(g.left + g.width / 2), Math.round(g.top + g.height / 2)) : null;
									const hitIsGrip = Boolean(hit && hit.closest && hit.closest('[data-dpo="resize"]'));
									if (grip && panel && g) {
										const pt = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1, button: 0, clientX: x, clientY: y });
										const cx = g.left + g.width / 2; const cy = g.top + g.height / 2;
										grip.dispatchEvent(pt("pointerdown", cx, cy));
										grip.dispatchEvent(pt("pointermove", cx - 130, cy - 100));
										grip.dispatchEvent(pt("pointerup", cx - 130, cy - 100));
									}
									window.setTimeout(() => {
										const r1 = panel ? panel.getBoundingClientRect() : null;
										const delta = r0 && r1 ? { dw: Math.round(r1.width - r0.width), dh: Math.round(r1.height - r0.height) } : null;
										beacon("resize-demo", {
											exists: Boolean(panel), gripExists: Boolean(grip),
											gripRect: g ? { l: Math.round(g.left), t: Math.round(g.top), w: Math.round(g.width), h: Math.round(g.height) } : null,
											hitIsGrip, hitWhat: hit ? String((hit.getAttribute && hit.getAttribute("data-dpo")) || hit.className || hit.tagName) : null,
											before: r0 ? { w: Math.round(r0.width), h: Math.round(r0.height) } : null,
											after: r1 ? { w: Math.round(r1.width), h: Math.round(r1.height) } : null,
											delta, stored: store.overlaySize || null,
											pass: Boolean(panel && grip && hitIsGrip && delta && delta.dw <= -120 && delta.dw >= -145 && delta.dh <= -90 && delta.dh >= -115),
										});
										store.overlaySize = keepSize;
										store.suppressUiPersist = false;
										setOverlay({ open: false, sessionId: store.viewSessionId });
										emit();
									}, 260);
								}, 300);
								return;
							}
							// 会话隔离自检（宿主下发）：开一个弹窗 → 切到别的会话 → 切回 → 用 DOM 判定
							if (cmd.run === "session-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								const real = store.viewSessionId;
								setOverlay({ open: true, text: "会话隔离自检", fullText: "会话隔离自检", src: "demo", sessionId: real });
								emit();
								window.setTimeout(() => {
									const before = { open: store.overlay.open === true, dom: Boolean(document.querySelector('[data-dpo="overlay"]')), text: store.overlay.text };
									onViewSessionChange("__dpo_other_session__");
									window.setTimeout(() => {
										const away = { open: store.overlay.open === true, dom: Boolean(document.querySelector('[data-dpo="overlay"]')), viewSessionId: store.viewSessionId };
										onViewSessionChange(real);
										window.setTimeout(() => {
											const back = { open: store.overlay.open === true, dom: Boolean(document.querySelector('[data-dpo="overlay"]')), text: store.overlay.text, viewSessionId: store.viewSessionId };
											beacon("session-demo", {
												realSession: real, before, away, back,
												pass: before.dom === true && away.dom === false && back.dom === true && back.text === before.text && away.viewSessionId === "__dpo_other_session__",
											});
											setOverlay({ open: false, sessionId: real });
											store.stash = {};
											emit();
										}, 320);
									}, 320);
								}, 320);
								return;
							}
							// 控件行自检（宿主下发）：量滑块长度/字号/是否换行或被裁 —— 验证"舒适度"是数字而不是感觉
							if (cmd.run === "controls-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								window.setTimeout(() => {
									const box = document.querySelector('[data-dpo="controls"]');
									const tierTrack = document.querySelector('[data-dpo="tier-track"]');
									const permTrack = document.querySelector('[data-dpo="perm-track"]');
									const tierVal = document.querySelector('[data-dpo="tier-value"]');
									const permVal = document.querySelector('[data-dpo="perm-value"]');
									const pill = document.querySelector('[data-dpo="model"]');
									const r = box ? box.getBoundingClientRect() : null;
									const fs = (el) => (el ? getComputedStyle(el).fontSize : null);
									const tw = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
									beacon("controls-demo", {
										exists: Boolean(box),
										controls: r ? { w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), right: Math.round(r.right) } : null,
										viewport: { w: window.innerWidth, h: window.innerHeight },
										tierTrackW: tw(tierTrack), permTrackW: tw(permTrack),
										trackH: tierTrack ? Math.round(tierTrack.getBoundingClientRect().height) : null,
										fonts: { tierValue: fs(tierVal), permValue: fs(permVal), model: fs(pill) },
										wrapped: Boolean(r) && r.height > 40,
										clipped: box ? box.scrollWidth > box.clientWidth + 1 : null,
										overflowRight: Boolean(r) && r.right > window.innerWidth,
										narrow: store.narrow === true,
									});
								}, 400);
								return;
							}
							// 纯可见性自检（宿主下发）：只开关一次浮层，不跑优化、不改档位、不发消息
							if (cmd.run === "overlay-demo") {
								lastToken = cmd.token;
								window.__DPO_LAST_TOKEN__ = cmd.token;
								beacon("overlay-demo-start", { token: cmd.token, activeInstance: isActiveInstance(), tier: store.tier, permission: store.permission });
								setOverlay({ open: true, text: "浮层可见性自检（不优化、不发送）", fullText: "", src: "demo" });
								window.setTimeout(() => { beaconOverlayGeom("demo"); }, 300);
								window.setTimeout(() => { setOverlay({ open: false }); beacon("overlay-demo-end", {}); }, 7000);
								return;
							}
							// 用户忙就不抢：优化在跑 / 浮层开着 / 输入框有草稿 → 让路（不消耗 token，稍后再试）
							const busyRun = store.run && (store.run.status === "connecting" || store.run.status === "running");
							const draftBusy = String(draftLive() || "").trim().length > 0;
							if (busyRun || store.overlay.open || draftBusy) {
								beacon("probe-deferred", {
									reason: busyRun ? "run-in-flight" : (store.overlay.open ? "overlay-open" : "draft-non-empty"),
									token: cmd.token, tier: store.tier, permission: store.permission,
								});
								return;
							}
							window.__DPO_PROBE_RUNNING__ = true;
							lastToken = cmd.token;
							window.__DPO_LAST_TOKEN__ = cmd.token;
							beacon("probe-start", { token: cmd.token, cmdAgeMs: d.cmdAgeMs === undefined ? null : d.cmdAgeMs, tier: store.tier, permission: store.permission });
							runProbe(ctx, cmd.token).catch((e) => {
								window.__DPO_PROBE_RUNNING__ = false;
								store.probeError = String(e);
								emit();
								void post("/report", { plugin: NS, token: cmd.token, kind: "selftest-error", error: String(e), windowStart: Date.now(), windowEnd: Date.now(), steps: [], passed: 0, total: 0 });
							});
						})
						.catch(() => { /* host 未就绪时静默 */ });
				}, 2000);
				return () => window.clearInterval(timer);
			}, NS + ": probe poll");

			// 控制台手测入口（与探针同一套判定真源）
			window.__DPO__ = {
				store,
				labels: () => [...SEND_LABELS],
				interceptKey,
				wouldInterceptClick,
				cardOf,
				editorOf,
				disarm: () => { store.armed = false; return store.armed; },
				arm: () => { store.armed = true; return store.armed; },
				probe: (token) => runProbe(ctx, token || "manual-" + Date.now()),
			};
		};

		return module.exports;
	}
});
