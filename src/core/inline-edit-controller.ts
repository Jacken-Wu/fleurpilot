// core/inline-edit-controller.ts —— 内联改写任务控制器
// 承接原 InlineEditModal 的全部功能逻辑：上下文抓取、生成、多轮追问、
// 打断/重生成、延后应用与位置追踪。UI 仅订阅本控制器，不碰生成逻辑。
import { App, Editor, MarkdownView, Notice, TFile, TFolder } from 'obsidian';
import type FleurPilotPlugin from '../main';
import { LLMService, ChatMessage } from './llm-service';
import { DEFAULT_INLINE_SYSTEM_PROMPT, type FleurPilotSettings } from '../settings';
import { t } from '../i18n';

export type InlineEditAction =
    | 'explain'
    | 'simplify'
    | 'expand'
    | 'elaborate'
    | 'polish'
    | 'translate_zh'
    | 'translate_en'
    | 'proofread'
    | 'continue'
    | 'custom';

/** 携带的笔记上下文字符上限，防止长笔记撑爆 token */
const NOTE_CONTEXT_LIMIT = 12000;
/** 选区前后各取多少字符作为重定位指纹 */
const FINGERPRINT = 64;
/** 无选区续写时，取光标前多少字符作为输入 */
const CONTINUE_PRECEDING_LIMIT = 3000;

export const ACTION_PROMPTS: Record<InlineEditAction, string> = {
    explain: '请解释这段内容的含义，用更通俗易懂的方式表达：',
    simplify: '请精简这段文字，去除冗余表达，保留核心信息：',
    expand: `任务：扩写下面这段笔记，把已经表达完整的意思讲得更充分。
要求：
- 保留原文全部观点、立场与事实；只做原文逻辑可自然推出的补充（细节、解释、例子、过渡）。
- 绝不引入原文推不出的新事实、数据、来源或结论；不确定的一律不写。
- 维持原文的语气、人称与风格，衔接自然，不重复、不啰嗦。
- Markdown 结构按系统规则处理。
直接输出扩写后的正文，不要任何说明。`,
    elaborate: `任务：把下面这个关键词、短语或提纲，展开成完整、连贯的正文。
目标：读者读完后能理解这个条目，而不是只看到一个标签。
要求：
- 围绕该条目，把应有的含义、要点或必要背景写清楚，组织成一段或若干段通顺的文字。
- 只写你确信的、公认的内容；不确定或存在争议的地方，用中性、保守的表述，绝不编造具体数字、日期、人名、来源或引用。
- 默认写成一段；内容确实需要分层时用简短分点，但不要套空泛的模板话术。
- 用简体中文；术语、专有名词、公式、单位保持准确；遵循系统关于 Markdown 结构的规则。
只输出展开后的正文，不要任何说明。`,
    polish: '请润色这段文字，优化表达，使其更加流畅专业：',
    translate_zh: '请将这段文字翻译为流畅的中文：',
    translate_en: 'Please translate this text into fluent English:',
    proofread: `任务：校对下面这段笔记。这是"校对"而非"润色"：只纠错，不做风格改写，不追求"读起来更好"。
要求：
- 只修正错别字、多字、漏字、语法错误、标点误用、明显的搭配错误，以及事实或术语层面的自相矛盾（如前后数字、结论、称谓、专有名词不一致）。
- 严格保守：可改可不改的地方一律不动，保留原文的用词习惯、语气和表达风格；改动量与错误数量成正比，绝不顺手重写没问题的句子。
- Markdown 结构按系统规则处理。
- 若没有可改之处，原样返回。
直接输出校对后的正文，不要说明改了什么。`,
    continue: '请接着下面的内容继续往下写。要求：\n1. 只输出续写的新内容，绝对不要重复已有的文字\n2. 保持与原文一致的写作风格、语气、人称和叙述节奏\n3. 从原文末尾自然衔接，不要另起多余的空行\n4. 篇幅适中，约 100-300 字，视原文语境而定\n5. 直接输出正文，不要加任何说明、标题或前后缀',
    custom: '',
};

export interface Pos {
    line: number;
    ch: number;
}

/** 一个待处理的内联改写任务（生命周期：generating → ready → applied | failed | stale） */
export interface PendingEdit {
    id: string;
    /** 目标 Markdown 文件路径；白板等非 md 场景为空串 */
    filePath: string;
    fileName: string;
    /** 非 md 场景（如白板文本节点）下持有的编辑器引用，用于定位应用 */
    liveEditor?: Editor;
    action: InlineEditAction;
    customInstruction: string;
    // ── 定位锚点（触发瞬间定格）──
    from: Pos;
    to: Pos;
    originalText: string;
    beforeCtx: string;
    afterCtx: string;
    // ── 生成输入快照 ──
    sourceText: string;
    contextSnapshot: string;
    contextLabel: string;
    contextOn: boolean;
    insertMode: 'replace' | 'append';
    // ── 结果与状态 ──
    status: 'generating' | 'ready' | 'applied' | 'failed' | 'stale';
    result: string;
    error?: string;
    createdAt: number;
    /** 多轮追问的对话历史 */
    conversationMessages: ChatMessage[];
    /** 是否正在进行追问生成 */
    busy: boolean;
    /** 生成代次，用于让过期流式回调失效 */
    generationId: number;
}

type Listener = () => void;

interface SubmitOptions {
    editor: Editor;
    /** 目标 Markdown 文件；非 md（白板等）传 null */
    file: TFile | null;
    /** 卡片显示的来源名（文件名） */
    displayName: string;
    action: InlineEditAction;
    customInstruction?: string;
    insertMode: 'replace' | 'append';
}

export class InlineEditController {
    private app: App;
    private plugin: FleurPilotPlugin;
    private items: PendingEdit[] = [];
    private llms = new Map<string, LLMService>();
    private listeners = new Set<Listener>();
    private seq = 0;

    constructor(app: App, plugin: FleurPilotPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    private $(key: string, params?: string | Record<string, string>): string {
        return t(this.plugin.settings.language, key, params);
    }

    onChange(cb: Listener): () => void {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
    }

    private emit(): void {
        for (const l of Array.from(this.listeners)) {
            try { l(); } catch { /* 单个订阅者异常不影响其他 */ }
        }
    }

    getItems(): readonly PendingEdit[] {
        return this.items;
    }

    /** 触发一次任务：同步抓快照入队，再异步抓上下文并生成 */
    async submit(opts: SubmitOptions): Promise<void> {
        const { editor, file, action } = opts;
        const from = editor.getCursor('from');
        const to = editor.getCursor('to');
        const originalText = editor.getRange(from, to);
        const value = editor.getValue();
        const fromOff = editor.posToOffset(from);
        const toOff = editor.posToOffset(to);
        const beforeCtx = value.slice(Math.max(0, fromOff - FINGERPRINT), fromOff);
        const afterCtx = value.slice(toOff, toOff + FINGERPRINT);
        const sourceText = originalText
            || (action === 'continue' ? value.slice(Math.max(0, fromOff - CONTINUE_PRECEDING_LIMIT), fromOff) : '');

        const item: PendingEdit = {
            id: `ie_${Date.now().toString(36)}_${++this.seq}`,
            filePath: file ? file.path : '',
            fileName: opts.displayName,
            liveEditor: file ? undefined : editor,
            action,
            customInstruction: opts.customInstruction || '',
            from, to, originalText, beforeCtx, afterCtx,
            sourceText,
            contextSnapshot: '',
            contextLabel: this.$('inline.contextLoading'),
            contextOn: false,
            insertMode: opts.insertMode,
            status: 'generating',
            result: '',
            createdAt: Date.now(),
            conversationMessages: [],
            busy: false,
            generationId: 0,
        };
        this.items.push(item);
        this.emit();

        await this.loadContext(item, file);
        this.emit();
        await this.runFirstTurn(item);
    }

    /** 依当前设置重新抓取某任务的上下文并重新生成（供切换上下文来源用） */
    async reloadContext(item: PendingEdit): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(item.filePath);
        if (file instanceof TFile) await this.loadContext(item, file);
        this.emit();
        await this.runFirstTurn(item);
    }

    /** 应用结果：仅当目标仍在编辑器中打开时才允许（兼顾撤销栈与"改了什么"的确认）*/
    apply(item: PendingEdit): void {
        let editor: Editor | null = null;
        if (item.filePath) {
            const file = this.app.vault.getAbstractFileByPath(item.filePath);
            if (!(file instanceof TFile)) {
                new Notice(this.$('notice.inlineFileGone'));
                return;
            }
            editor = this.findEditorFor(file);
            if (!editor) {
                new Notice(this.$('notice.inlineFileClosed'));
                return;
            }
        } else {
            // 非 md（白板等）：用触发时持有的编辑器引用
            editor = item.liveEditor ?? null;
            if (!editor) {
                new Notice(this.$('notice.inlineFileClosed'));
                return;
            }
        }
        const located = this.locate(editor, item);
        if (!located) {
            item.status = 'stale';
            this.emit();
            new Notice(this.$('notice.inlineStale'));
            return;
        }
        const { from, to } = located;
        const change = item.insertMode === 'append'
            ? { from: to, to, text: item.result }
            : { from, to, text: item.result };
        try {
            editor.transaction({ changes: [change] });
        } catch {
            item.status = 'stale';
            this.emit();
            new Notice(this.$('notice.inlineStale'));
            return;
        }
        this.items = this.items.filter((i) => i.id !== item.id);
        this.emit();
        new Notice(item.action === 'continue' ? this.$('inline.appliedContinue') : this.$('inline.applied'));
    }

    discard(item: PendingEdit): void {
        this.llms.get(item.id)?.cancel();
        this.llms.delete(item.id);
        item.generationId++;
        this.items = this.items.filter((i) => i.id !== item.id);
        this.emit();
    }

    async retry(item: PendingEdit): Promise<void> {
        this.llms.get(item.id)?.cancel();
        item.generationId++;
        item.busy = false;
        await this.runFirstTurn(item);
    }

    async followUp(item: PendingEdit, instruction: string): Promise<void> {
        const text = instruction.trim();
        if (!text || item.busy) return;
        item.busy = true;
        item.conversationMessages.push({ role: 'user', content: text });
        item.result = '';
        item.error = undefined;
        item.status = 'generating';
        this.emit();
        await this.stream(item);
    }

    // ── 生成 ─────────────────────────────────────────────

    private async runFirstTurn(item: PendingEdit): Promise<void> {
        item.conversationMessages = [{ role: 'user', content: this.buildPrompt(item) }];
        item.result = '';
        item.error = undefined;
        item.busy = false;
        item.status = 'generating';
        this.emit();
        await this.stream(item);
    }

    private async stream(item: PendingEdit): Promise<void> {
        const llm = new LLMService(this.inlineLLMSettings());
        this.llms.set(item.id, llm);
        const genId = ++item.generationId;
        try {
            await llm.sendMessage(
                item.conversationMessages,
                (chunk) => {
                    if (item.generationId !== genId) return;
                    item.result += chunk;
                    this.emit();
                },
                () => {
                    if (item.generationId !== genId) return;
                    item.conversationMessages.push({ role: 'assistant', content: item.result });
                    item.status = 'ready';
                    item.busy = false;
                    this.emit();
                },
            );
        } catch (error: unknown) {
            if (item.generationId !== genId) return;
            item.status = 'failed';
            item.busy = false;
            item.error = error instanceof Error ? error.message : 'Unknown error';
            this.emit();
        } finally {
            this.llms.delete(item.id);
        }
    }

    private inlineLLMSettings(): FleurPilotSettings {
        return {
            ...this.plugin.settings,
            systemPrompt: this.plugin.settings.inlineSystemPrompt.trim() || DEFAULT_INLINE_SYSTEM_PROMPT,
        };
    }

    private actionPrompt(item: PendingEdit): string {
        const s = this.plugin.settings;
        const custom: Partial<Record<InlineEditAction, string>> = {
            polish: s.inlinePolishPrompt,
            expand: s.inlineExpandPrompt,
            elaborate: s.inlineElaboratePrompt,
            simplify: s.inlineShortenPrompt,
            continue: s.inlineContinuePrompt,
            explain: s.inlineExplainPrompt,
            proofread: s.inlineProofreadPrompt,
        };
        const cp = (custom[item.action] || '').trim();
        return cp || ACTION_PROMPTS[item.action];
    }

    private buildPrompt(item: PendingEdit): string {
        const ctx = item.contextSnapshot;
        if (item.action === 'custom' && item.customInstruction) {
            return `${ctx}请按照以下要求修改这段文字：\n\n要求：${item.customInstruction}\n\n原文：\n${item.sourceText}\n\n请直接输出修改后的文字，不要添加任何解释。`;
        }
        const ap = this.actionPrompt(item);
        if (item.action === 'continue') {
            return `${ctx}${ap}\n\n已有内容：\n${item.sourceText}\n\n请现在开始续写：`;
        }
        return `${ctx}${ap}\n\n${item.sourceText}\n\n请直接输出修改后的文字，不要添加任何解释。`;
    }

    // ── 定位与应用 ───────────────────────────────────────

    private findEditorFor(file: TFile): Editor | null {
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view;
            if (view instanceof MarkdownView && view.file?.path === file.path) {
                return view.editor;
            }
        }
        return null;
    }

    /**
     * 计算可用于应用的选区范围。
     * 1) 精确校验：当前位置仍是原文 → 直接用；
     * 2) 锚点重定位：以 beforeCtx + 原文 + afterCtx 指纹在全文中唯一匹配 → 换算新位置；
     * 3) 否则返回 null（上层标 stale，不盲目替换）。
     */
    private locate(editor: Editor, item: PendingEdit): { from: Pos; to: Pos } | null {
        // 1) 有原文时优先精确校验
        if (item.originalText) {
            try {
                if (editor.getRange(item.from, item.to) === item.originalText) {
                    return { from: item.from, to: item.to };
                }
            } catch { /* 位置越界，落到指纹重定位 */ }
        }
        // 2) 指纹重定位（beforeCtx + 原文 + afterCtx 唯一匹配）
        const needle = item.beforeCtx + item.originalText + item.afterCtx;
        if (needle) {
            const value = editor.getValue();
            const first = value.indexOf(needle);
            if (first >= 0 && value.indexOf(needle, first + 1) < 0) {
                const startOff = first + item.beforeCtx.length;
                return {
                    from: editor.offsetToPos(startOff),
                    to: editor.offsetToPos(startOff + item.originalText.length),
                };
            }
        }
        // 3) 无原文（续写无选区）且指纹不可用：退回记录位置，尽力而为
        if (!item.originalText) return { from: item.from, to: item.to };
        return null;
    }

    // ── 上下文抓取 ───────────────────────────────────────

    private async loadContext(item: PendingEdit, file: TFile | null): Promise<void> {
        const s = this.plugin.settings;
        if (!file || !s.enableInlineContext) {
            item.contextSnapshot = '';
            item.contextLabel = this.$('inline.contextNone');
            item.contextOn = false;
            return;
        }
        const customPaths = s.inlineContextPaths || [];
        if (customPaths.length > 0) {
            const ctx = await this.buildCustomContext(customPaths);
            if (!ctx.text) {
                item.contextSnapshot = '';
                item.contextLabel = this.$('inline.contextNone');
                item.contextOn = false;
                return;
            }
            item.contextSnapshot = `【参考上下文：自定义来源（${ctx.sourceCount} 处）】\n${ctx.text}\n\n请结合上述参考内容的主题、术语用法、叙述视角与写作风格来完成下面的任务。\n\n---\n\n`;
            item.contextLabel = this.$('inline.contextCustom', { count: String(ctx.sourceCount) });
            item.contextOn = true;
            return;
        }
        let content: string;
        try {
            content = await this.app.vault.cachedRead(file);
        } catch {
            item.contextSnapshot = '';
            item.contextLabel = this.$('inline.contextNone');
            item.contextOn = false;
            return;
        }
        content = this.stripFrontmatter(content).trim();
        // 仅当选区几乎覆盖整篇（内容与选区相同）时才视为冗余，放弃上下文。
        // 原判据 content.length <= sourceText.length + 20 对短笔记过于激进。
        const selection = item.sourceText.trim();
        if (!content || (selection !== '' && content === selection)) {
            item.contextSnapshot = '';
            item.contextLabel = this.$('inline.contextNone');
            item.contextOn = false;
            return;
        }
        const clipped = this.clipAroundSelection(content, item.sourceText);
        const scope = clipped.length < content.length ? '（节选）' : '全文';
        item.contextSnapshot = `【参考上下文：当前笔记《${file.basename}》${scope}】\n${clipped}\n\n请结合上述笔记的整体主题、术语用法、叙述视角与写作风格来完成下面的任务。\n\n---\n\n`;
        item.contextLabel = this.$('inline.contextNote', { name: file.basename });
        item.contextOn = true;
    }

    private async buildCustomContext(paths: string[]): Promise<{ text: string; sourceCount: number }> {
        const parts: string[] = [];
        let sourceCount = 0;
        const pushFile = async (file: TFile, maxChars: number) => {
            try {
                const content = this.stripFrontmatter(await this.app.vault.cachedRead(file)).trim();
                if (content) {
                    parts.push(`【${file.basename}】\n${content.slice(0, maxChars)}`);
                    sourceCount++;
                }
            } catch {
                // 单个来源读取失败不影响其他来源
            }
        };
        for (const path of paths) {
            const node = this.app.vault.getAbstractFileByPath(path);
            if (node instanceof TFile && node.extension === 'md') {
                await pushFile(node, 2500);
            } else if (node instanceof TFolder) {
                const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(node.path + '/'));
                for (const file of files.slice(0, 5)) {
                    await pushFile(file, 2000);
                }
            }
        }
        const text = parts.join('\n\n---\n\n').slice(0, NOTE_CONTEXT_LIMIT);
        return { text, sourceCount };
    }

    private clipAroundSelection(content: string, selectedText: string): string {
        if (content.length <= NOTE_CONTEXT_LIMIT) return content;
        const half = Math.floor(NOTE_CONTEXT_LIMIT / 2);
        const needle = selectedText.trim();
        const idx = needle ? content.indexOf(needle) : -1;
        if (idx >= 0) {
            const start = Math.max(0, idx - half);
            const end = Math.min(content.length, idx + needle.length + half);
            const head = start > 0 ? '…（前文已省略）\n\n' : '';
            const tail = end < content.length ? '\n\n…（后文已省略）' : '';
            return head + content.slice(start, end) + tail;
        }
        return '…（前文已省略）\n\n' + content.slice(-NOTE_CONTEXT_LIMIT);
    }

    private stripFrontmatter(content: string): string {
        return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    }
}
