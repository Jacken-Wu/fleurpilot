// views/inline-view.ts —— 内联改写侧边栏（独立 ItemView，不与 chat 复用）
// 仅负责展示与转发用户操作；所有生成/状态逻辑在内联改写控制器里。
import { ItemView, Menu, Notice, WorkspaceLeaf } from 'obsidian';
import type FleurPilotPlugin from '../main';
import { InlineEditAction, PendingEdit } from '../core/inline-edit-controller';
import { ContextSearchModal } from './chat-view';
import { t } from '../i18n';

export const VIEW_TYPE_INLINE = 'fleurpilot-inline-view';

interface CardRefs {
    el: HTMLElement;
    contextBadge: HTMLElement;
    statusEl: HTMLElement;
    originalText: HTMLElement;
    resultText: HTMLElement;
    btnApply: HTMLButtonElement;
    btnRetry: HTMLButtonElement;
    btnCopy: HTMLButtonElement;
    btnDiscard: HTMLButtonElement;
    followWrap: HTMLElement;
    followInput: HTMLTextAreaElement;
}

const ACTION_LABEL_KEYS: Partial<Record<InlineEditAction, string>> = {
    polish: 'menu.polish',
    simplify: 'menu.shorten',
    expand: 'menu.expand',
    elaborate: 'menu.elaborate',
    continue: 'menu.continue',
    translate_zh: 'menu.translateCN',
    translate_en: 'menu.translateEN',
    proofread: 'menu.proofread',
    explain: 'inline.actionExplain',
    custom: 'inline.actionCustom',
};

export class InlineEditView extends ItemView {
    private plugin: FleurPilotPlugin;
    private listEl!: HTMLElement;
    private emptyEl!: HTMLElement;
    private cards = new Map<string, CardRefs>();
    private unsub: (() => void) | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: FleurPilotPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    private $(key: string, params?: string | Record<string, string>): string {
        return t(this.plugin.settings.language, key, params);
    }

    getViewType(): string { return VIEW_TYPE_INLINE; }
    getDisplayText(): string { return this.$('inline.viewTitle'); }
    getIcon(): string { return 'wand-2'; }

    async onOpen(): Promise<void> {
        const root = this.contentEl;
        root.empty();
        root.addClass('mb-inline-view');

        this.emptyEl = root.createDiv({ cls: 'mb-inline-empty', text: this.$('inline.empty') });
        this.listEl = root.createDiv({ cls: 'mb-task-list' });

        this.unsub = this.plugin.inlineEdit.onChange(() => this.render());
        this.render();
    }

    async onClose(): Promise<void> {
        this.unsub?.();
        this.unsub = null;
        this.cards.clear();
        this.contentEl.empty();
    }

    private render(): void {
        const items = this.plugin.inlineEdit.getItems();
        this.emptyEl.toggleClass('mb-hidden', items.length > 0);

        const ids = new Set(items.map((i) => i.id));
        for (const [id, ref] of Array.from(this.cards)) {
            if (!ids.has(id)) {
                ref.el.remove();
                this.cards.delete(id);
            }
        }
        for (const item of items) {
            let ref = this.cards.get(item.id);
            if (!ref) {
                ref = this.createCard(item);
                this.cards.set(item.id, ref);
            }
            this.updateCard(ref, item);
        }
    }

    private actionLabel(action: InlineEditAction): string {
        return this.$(ACTION_LABEL_KEYS[action] || 'inline.title');
    }

    private createCard(item: PendingEdit): CardRefs {
        const el = this.listEl.createDiv({ cls: 'mb-task-card' });

        const head = el.createDiv({ cls: 'mb-task-head' });
        const title = head.createDiv({ cls: 'mb-task-title' });
        title.createSpan({ cls: 'mb-task-action', text: this.actionLabel(item.action) });
        title.createSpan({ cls: 'mb-task-file', text: item.fileName });
        const statusEl = head.createDiv({ cls: 'mb-task-status' });

        const contextBadge = el.createDiv({ cls: 'mb-task-context' });
        contextBadge.addEventListener('click', (e: MouseEvent) => this.showContextMenu(e, item));

        // 原文（可折叠）
        const originalWrap = el.createDiv({ cls: 'mb-task-original' });
        const oh = originalWrap.createDiv({ cls: 'mb-task-section-label mb-collapsible' });
        oh.createSpan({ text: item.action === 'continue' ? this.$('inline.originalContinue') : this.$('inline.original') });
        oh.createSpan({ text: '▾', cls: 'mb-collapse-arrow' });
        const originalText = originalWrap.createEl('pre', { text: item.sourceText, cls: 'mb-task-original-text' });
        oh.addEventListener('click', () => {
            originalText.classList.toggle('mb-collapsed');
            oh.classList.toggle('mb-collapsed');
        });

        // 结果
        const resultWrap = el.createDiv({ cls: 'mb-task-result' });
        resultWrap.createDiv({ cls: 'mb-task-section-label', text: this.$('inline.result') });
        const resultText = resultWrap.createDiv({ cls: 'mb-task-result-text' });

        // 追问
        const followWrap = el.createDiv({ cls: 'mb-task-follow' });
        const followLabel = followWrap.createDiv({ cls: 'mb-task-section-label' });
        followLabel.createSpan({ text: this.$('inline.followUpLabel') });
        followLabel.createSpan({
            text: item.action === 'continue' ? this.$('inline.followUpHintContinue') : this.$('inline.followUpHint'),
            cls: 'mb-task-follow-hint',
        });
        const followInput = followWrap.createEl('textarea', {
            cls: 'mb-task-follow-input',
            attr: { placeholder: this.$('inline.followUpPlaceholder') },
        });
        followInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.doFollowUp(item, followInput);
            }
        });
        const followSend = followWrap.createEl('button', { text: this.$('inline.send'), cls: 'mb-btn mb-btn-primary mb-task-follow-send' });
        followSend.addEventListener('click', () => this.doFollowUp(item, followInput));

        // 按钮组
        const btns = el.createDiv({ cls: 'mb-task-buttons' });
        const btnApply = btns.createEl('button', {
            text: item.action === 'continue' ? this.$('inline.applyContinue') : this.$('inline.apply'),
            cls: 'mb-btn mb-btn-apply',
        });
        btnApply.addEventListener('click', () => this.plugin.inlineEdit.apply(item));

        const btnRetry = btns.createEl('button', { text: this.$('inline.retry'), cls: 'mb-btn' });
        btnRetry.addEventListener('click', () => { void this.plugin.inlineEdit.retry(item); });

        const btnCopy = btns.createEl('button', { text: this.$('inline.copy'), cls: 'mb-btn' });
        btnCopy.addEventListener('click', () => {
            void navigator.clipboard.writeText(item.result)
                .then(() => new Notice(this.$('notice.inlineCopied')))
                .catch(() => { /* 剪贴板不可用时静默 */ });
        });

        const btnDiscard = btns.createEl('button', { text: this.$('inline.cancel'), cls: 'mb-btn mb-btn-cancel' });
        btnDiscard.addEventListener('click', () => this.plugin.inlineEdit.discard(item));

        return { el, contextBadge, statusEl, originalText, resultText, btnApply, btnRetry, btnCopy, btnDiscard, followWrap, followInput };
    }

    private doFollowUp(item: PendingEdit, input: HTMLTextAreaElement): void {
        const value = input.value.trim();
        if (!value) return;
        input.value = '';
        void this.plugin.inlineEdit.followUp(item, value);
    }

    private updateCard(ref: CardRefs, item: PendingEdit): void {
        ref.contextBadge.setText(item.contextLabel);
        ref.contextBadge.toggleClass('mb-task-context-on', item.contextOn);

        const statusKey = item.status === 'generating' ? 'inline.statusGenerating'
            : item.status === 'failed' ? 'inline.statusFailed'
            : item.status === 'stale' ? 'inline.statusStale'
            : 'inline.statusReady';
        ref.statusEl.setText(this.$(statusKey));
        ref.el.toggleClass('mb-task-ready', item.status === 'ready');
        ref.el.toggleClass('mb-task-error', item.status === 'failed' || item.status === 'stale');

        if (item.status === 'generating' && !item.result) {
            ref.resultText.setText(this.$(item.action === 'continue' ? 'inline.loadingContinue' : 'inline.loading'));
            ref.resultText.addClass('mb-task-loading');
        } else {
            ref.resultText.removeClass('mb-task-loading');
            ref.resultText.setText(item.error && item.status === 'failed' ? item.error : item.result);
        }

        const ready = item.status === 'ready';
        ref.btnApply.toggleClass('mb-hidden', !ready);
        ref.btnRetry.toggleClass('mb-hidden', !(item.status === 'failed' || item.status === 'stale'));
        ref.btnCopy.toggleClass('mb-hidden', !(ready || item.status === 'stale'));
        ref.btnDiscard.setText(item.status === 'generating' ? this.$('inline.cancel') : this.$('inline.discard'));
        ref.followWrap.toggleClass('mb-hidden', !ready);
    }

    private showContextMenu(event: MouseEvent, item: PendingEdit): void {
        const s = this.plugin.settings;
        const paths = s.inlineContextPaths || [];
        const enabled = s.enableInlineContext;
        const isActive = enabled && paths.length === 0;
        const isCustom = enabled && paths.length > 0;
        const isNone = !enabled;

        const menu = new Menu();
        menu.addItem((mi) => {
            mi.setTitle(`${this.$('inline.contextMenuActive')}${isActive ? '  ✓' : ''}`)
                .setIcon('file-text')
                .onClick(() => {
                    s.enableInlineContext = true;
                    s.inlineContextPaths = [];
                    void this.plugin.saveSettings();
                    void this.plugin.inlineEdit.reloadContext(item);
                });
        });
        menu.addItem((mi) => {
            const label = isCustom
                ? `${this.$('inline.contextMenuCustom')}（${paths.map((p) => p.split('/').pop()).join(', ')}）`
                : this.$('inline.contextMenuCustom');
            mi.setTitle(`${label}${isCustom ? '  ✓' : ''}`)
                .setIcon('folder-search')
                .onClick(() => {
                    new ContextSearchModal(this.app, (selectedPaths) => {
                        if (selectedPaths.length === 0) return;
                        s.enableInlineContext = true;
                        s.inlineContextPaths = selectedPaths;
                        void this.plugin.saveSettings();
                        void this.plugin.inlineEdit.reloadContext(item);
                    }).open();
                });
        });
        menu.addSeparator();
        menu.addItem((mi) => {
            mi.setTitle(`${this.$('inline.contextMenuNone')}${isNone ? '  ✓' : ''}`)
                .setIcon('x-circle')
                .onClick(() => {
                    s.enableInlineContext = false;
                    s.inlineContextPaths = [];
                    void this.plugin.saveSettings();
                    void this.plugin.inlineEdit.reloadContext(item);
                });
        });
        menu.showAtMouseEvent(event);
    }
}
