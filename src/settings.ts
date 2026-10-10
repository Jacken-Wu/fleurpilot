// settings.ts - FleurPilot 配置
// 使用 Obsidian 1.13+ 声明式设置 API
// 移除 display() 方法以通过 obsidianmd/no-deprecated-display 规则审查
import { App, PluginSettingTab, Notice, SettingDefinitionItem } from 'obsidian';
import type FleurPilotPlugin from './main';
import { t, Lang } from './i18n';

export interface ModelPreset {
    id: string;
    name: string;
    baseUrl: string;
    model: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'qwen', name: '通义千问 (DashScope)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'glm', name: '智谱 (GLM)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct' },
    { id: 'custom', name: '自定义', baseUrl: '', model: '' },
];

/**
 * 内联编辑专用的默认系统提示词。
 * 与对话（chat）的系统提示词分开：内联编辑是"就地改写"任务，需要一套
 * 面向成品输出、保真、Markdown 结构的严格纪律，不能与闲聊式对话共用。
 */
export const DEFAULT_INLINE_SYSTEM_PROMPT = `你是我的私人笔记写作助手，服务于一个以中文为主、可能夹杂英文术语的 Markdown 知识库，默认使用简体中文输出。

全局纪律（优先级最高）：
1. 输出即成品。只输出可以直接使用或直接替换原文的正文，绝不添加解释、前言、结语、客套话，不写"以下是……""改动如下：""希望对你有帮助"之类的内容，也不要用代码块或引号把整段结果包起来。
2. 保真。不改变原意，不增删事实与关键信息，不臆造数据、引用、来源或结论；不确定的信息宁可不写。
3. 输出 Markdown。默认使用 Markdown 格式。
   3.1 已有结构保持不变。若输入带有 Markdown 块级标记，保持每个块的类型与层级不变：标题仍是同级标题，列表仍是列表，段落仍是段落，引用仍是引用。不升级、不降级、不新增块级标记。
   3.2 纯文本需推断结构。若输入不含任何 Markdown 块级标记、看起来是纯文本，则先判断它包含哪几个语义块，再把各块补全为规范 Markdown：
       - 独立成行、简短、无句末标点、语义上像主题标签的行 → 标题（顶层默认用 ##，逐级用 ###、####）；
       - 行首带数字序号或项目符号，或若干并列短句分行排列 → 有序列表或无序列表；
       - 连续的普通叙述 → 段落；
       - 转述他人观点或标注来源的行 → 引用（>）；
       - 多行多列、明显成表的数据 → 表格（仅在分隔清晰时）。
       推断务必克制：只在信号明确时升级结构，模棱两可时一律保留为普通段落，绝不无中生有地制造标题、列表或表格。结构推断只添加块级标记，不改动文字本身，也不改变句子的语序与用词（这段不算违反第 2 条）。
   3.3 单段落例外。若输入不含块级结构，且本身只是一个单独段落（单一语义块），输出一个普通段落即可，不添加任何块级标记（不加 #、>、-、*、数字序号、代码围栏），也不改写为标题、列表或引用；只保留该段落内原本已有的行内格式（加粗、斜体、行内代码、链接、公式等）。
   3.4 判断顺序。先看输入是否含块级标记：含 → 按 3.1 保留；不含且含多个语义块 → 按 3.2 推断补全；不含且只有单一语义块 → 按 3.3 原样输出。判断依据是结构信号，不是文本长度。
4. 保细节。人名、地名、专有名词、术语、缩写、数字、单位、公式、代码、文件名一律保持准确。
5. 中文正文用中文标点；代码、命令、链接、英文术语按各自规范书写。不使用 emoji，除非原文已在用。
6. 语气克制、准确、自然，优先清晰与信息密度，不堆砌辞藻。

若具体任务指令与上述冲突，以具体任务指令为准。`;

export interface FleurPilotSettings {
    provider: string;
    baseUrl: string;
    apiKey: string;
    /** 密钥保存位置：system=系统钥匙串（默认），vault=data.json 明文随 vault 同步。 */
    secretStorageMode: 'system' | 'vault';
    model: string;
    reasoningModel: string;
    /** 对话（chat 侧边栏）的系统提示词 */
    systemPrompt: string;
    /** 内联编辑专用的系统提示词（与 chat 分开） */
    inlineSystemPrompt: string;
    temperature: number;
    maxTokens: number;
    enableContext: boolean;
    enableInlineContext: boolean;
    /** 内联编辑的自定义上下文来源（文件夹或笔记路径）；空数组 = 默认当前笔记 */
    inlineContextPaths: string[];
    /** 内联编辑各动作的自定义提示词，留空表示使用内置默认 */
    inlinePolishPrompt: string;
    inlineExpandPrompt: string;
    inlineShortenPrompt: string;
    inlineContinuePrompt: string;
    inlineExplainPrompt: string;
    inlineElaboratePrompt: string;
    inlineProofreadPrompt: string;
    enableInlineEdit: boolean;
    enableQuickCommands: boolean;
    enableChatHistory: boolean;
    chatHistoryFolder: string;
    language: Lang;
}

export const DEFAULT_SETTINGS: FleurPilotSettings = {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    secretStorageMode: 'system',
    model: 'deepseek-chat',
    reasoningModel: 'deepseek-reasoner',
    systemPrompt: '你是一位专业的写作伙伴，熟悉各类文本的梳理、润色与扩展。请基于用户提供的笔记内容，给出清晰、准确、可直接使用的回复，保持简洁、克制、实用。',
    inlineSystemPrompt: DEFAULT_INLINE_SYSTEM_PROMPT,
    temperature: 0.7,
    maxTokens: 4096,
    enableContext: true,
    enableInlineContext: true,
    inlineContextPaths: [],
    inlinePolishPrompt: '',
    inlineExpandPrompt: '',
    inlineShortenPrompt: '',
    inlineContinuePrompt: '',
    inlineExplainPrompt: '',
    inlineElaboratePrompt: '',
    inlineProofreadPrompt: '',
    enableInlineEdit: true,
    enableQuickCommands: true,
    enableChatHistory: false,
    chatHistoryFolder: 'FleurPilot',
    language: 'zh-CN',
};

/**
 * 根据当前 provider 从预设中应用 baseUrl 和 model
 * 声明式 API 不支持 onChange 回调,因此通过命令触发该逻辑
 */
export function applyProviderPreset(settings: FleurPilotSettings): FleurPilotSettings {
    const preset = MODEL_PRESETS.find(p => p.id === settings.provider);
    if (preset && preset.id !== 'custom') {
        return { ...settings, baseUrl: preset.baseUrl, model: preset.model };
    }
    return settings;
}

export class FleurPilotSettingTab extends PluginSettingTab {
    plugin: FleurPilotPlugin;

    constructor(app: App, plugin: FleurPilotPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * 重写 setControlValue：当 provider 变化时自动同步预设的 baseUrl 和 model
     * 声明式 API 的 control 不支持 onChange，通过此方法拦截值变更
     *
     * super 会把值写进 plugin.settings 并调用 plugin.saveData —— 后者已被插件重写为
     * 「写盘前抹掉密钥」，所以这条路径同样不会把明文密钥落进 data.json。
     */
    async setControlValue(key: string, value: unknown): Promise<void> {
        // 密钥保存位置切换：走完整的搬迁 + 校验 + 回滚流程，而不是直接改值落盘
        if (key === 'secretStorageMode') {
            const $ = (k: string, fb?: string) => t(this.plugin.settings.language, k, fb);
            const mode = value === 'vault' ? 'vault' : 'system';
            const result = await this.plugin.setSecretStorageMode(mode);
            if (!result.ok) {
                new Notice($('notice.secretMoveFailed'));
            } else if (mode === 'vault') {
                new Notice($('notice.secretMovedVault'));
            } else {
                new Notice($('notice.secretMovedSystem'));
            }
            // 重新渲染，让密钥说明回到与实际模式一致的措辞（失败时也会显示回滚后的值）
            this.update();
            return;
        }
        await super.setControlValue(key, value);
        if (key === 'provider' && typeof value === 'string') {
            const preset = MODEL_PRESETS.find(p => p.id === value);
            if (preset && preset.id !== 'custom') {
                this.plugin.settings.baseUrl = preset.baseUrl;
                this.plugin.settings.model = preset.model;
                await this.plugin.saveSettings();
                this.update();
            }
        }
    }

    /**
     * Obsidian 1.13+ 声明式设置 API
     * 让设置项出现在 Obsidian 设置搜索中
     */
    getSettingDefinitions(): SettingDefinitionItem[] {
        const $ = (key: string, fb?: string | Record<string, string>) => t(this.plugin.settings.language, key, fb);
        const presetOptions: Record<string, string> = {};
        for (const p of MODEL_PRESETS) presetOptions[p.id] = p.name;

        return [
            {
                name: $('settings.provider'),
                desc: $('settings.providerDesc'),
                control: {
                    type: 'dropdown',
                    key: 'provider',
                    options: presetOptions,
                },
            },
            {
                name: $('settings.baseUrl'),
                desc: $('settings.baseUrlDesc'),
                control: {
                    type: 'text',
                    key: 'baseUrl',
                    placeholder: $('settings.baseUrlPlaceholder'),
                },
            },
            {
                // 密钥保存位置：切换走 setControlValue 拦截里的完整搬迁流程
                name: $('settings.secretModeName'),
                desc: this.plugin.secretStorageAvailable
                    ? $('settings.secretModeDesc')
                    : $('settings.secretModeUnavailable'),
                control: {
                    type: 'dropdown',
                    key: 'secretStorageMode',
                    options: {
                        system: $('settings.secretModeOptionSystem'),
                        vault: $('settings.secretModeOptionVault'),
                    },
                },
            },
            {
                name: $('settings.apiKey'),
                desc: this.secretDesc($),
                // 声明式设置 API 没有密码型控件，用 render 手动挂一个遮蔽输入框，
                // 避免密钥在设置界面上以明文显示（写盘仍统一走 plugin.saveSettings）。
                render: (setting) => {
                    setting.addText((text) => {
                        text
                            .setPlaceholder($('settings.apiKeyPlaceholder'))
                            .setValue(this.plugin.settings.apiKey)
                            .onChange(async (value) => {
                                this.plugin.settings.apiKey = value;
                                await this.plugin.saveSettings();
                            });
                        text.inputEl.type = 'password';
                        text.inputEl.autocomplete = 'off';
                    });
                },
            },
            {
                name: $('settings.model'),
                desc: $('settings.modelDesc'),
                control: {
                    type: 'text',
                    key: 'model',
                    placeholder: $('settings.modelPlaceholder'),
                },
            },
            {
                name: $('settings.reasoningModel'),
                desc: $('settings.reasoningModelDesc'),
                control: {
                    type: 'text',
                    key: 'reasoningModel',
                    placeholder: $('settings.reasoningModelPlaceholder'),
                },
            },
            {
                name: $('settings.testConnection'),
                desc: $('settings.testConnectionDesc'),
                action: () => {
                    void (async () => {
                        const { LLMService } = await import('./core/llm-service');
                        const llm = new LLMService(this.plugin.settings);
                        let result = '';
                        try {
                            await llm.sendMessage(
                                [{ role: 'user', content: $('settings.connectionTestPrompt') }],
                                (chunk) => { result += chunk; },
                                () => { /* done */ },
                            );
                            new Notice($('notice.testSuccess', { response: result.slice(0, 30) }));
                        } catch (error: unknown) {
                            const msg = error instanceof Error ? error.message.slice(0, 50) : 'Unknown error';
                            new Notice($('notice.testFailed', { error: msg }));
                        }
                    })();
                },
            },
            {
                name: $('settings.temperature'),
                desc: $('settings.temperatureDesc'),
                control: {
                    type: 'slider',
                    key: 'temperature',
                    min: 0,
                    max: 1,
                    step: 0.1,
                },
            },
            {
                name: $('settings.maxTokens'),
                desc: $('settings.maxTokensDesc'),
                control: {
                    type: 'slider',
                    key: 'maxTokens',
                    min: 512,
                    max: 16384,
                    step: 512,
                },
            },
            {
                name: $('settings.enableContext'),
                desc: $('settings.enableContextDesc'),
                control: {
                    type: 'toggle',
                    key: 'enableContext',
                },
            },
            {
                name: $('settings.enableInlineContext'),
                desc: $('settings.enableInlineContextDesc'),
                control: {
                    type: 'toggle',
                    key: 'enableInlineContext',
                },
            },
            {
                type: 'group',
                heading: $('settings.promptGroupSystem'),
                items: [
                    {
                        name: $('settings.systemPrompt'),
                        desc: $('settings.systemPromptDesc'),
                        control: {
                            type: 'textarea',
                            key: 'systemPrompt',
                            placeholder: $('settings.systemPromptPlaceholder'),
                            rows: 3,
                        },
                    },
                    {
                        name: $('settings.inlineSystemPrompt'),
                        desc: $('settings.inlineSystemPromptDesc'),
                        control: {
                            type: 'textarea',
                            key: 'inlineSystemPrompt',
                            placeholder: $('settings.inlineSystemPromptPlaceholder'),
                            rows: 6,
                        },
                    },
                ],
            },
            {
                type: 'group',
                heading: $('settings.promptGroupAction'),
                items: [
                    {
                        name: $('settings.inlinePolishPrompt'),
                        desc: $('settings.inlinePromptDesc'),
                        control: {
                            type: 'textarea',
                            key: 'inlinePolishPrompt',
                            placeholder: $('settings.inlinePromptPlaceholder'),
                            rows: 2,
                        },
                    },
                    {
                        name: $('settings.inlineExpandPrompt'),
                        desc: $('settings.inlinePromptDesc'),
                        control: {
                            type: 'textarea',
                            key: 'inlineExpandPrompt',
                            placeholder: $('settings.inlinePromptPlaceholder'),
                            rows: 2,
                        },
                    },
                    {
                        name: $('settings.inlineElaboratePrompt'),
                        desc: $('settings.inlinePromptDesc'),
                        control: {
                            type: 'textarea',
                            key: 'inlineElaboratePrompt',
                            placeholder: $('settings.inlinePromptPlaceholder'),
                            rows: 2,
                        },
                    },
                    {
                        name: $('settings.inlineShortenPrompt'),
                        desc: $('settings.inlinePromptDesc'),
                        control: {
                            type: 'textarea',
                            key: 'inlineShortenPrompt',
                            placeholder: $('settings.inlinePromptPlaceholder'),
                            rows: 2,
                        },
                    },
                    {
                        name: $('settings.inlineContinuePrompt'),
                        desc: $('settings.inlinePromptDesc'),
                        control: {
                            type: 'textarea',
                            key: 'inlineContinuePrompt',
                            placeholder: $('settings.inlinePromptPlaceholder'),
                            rows: 2,
                        },
                    },
                    {
                        name: $('settings.inlineExplainPrompt'),
                        desc: $('settings.inlinePromptDesc'),
                        control: {
                            type: 'textarea',
                            key: 'inlineExplainPrompt',
                            placeholder: $('settings.inlinePromptPlaceholder'),
                            rows: 2,
                        },
                    },
                    {
                        name: $('settings.inlineProofreadPrompt'),
                        desc: $('settings.inlinePromptDesc'),
                        control: {
                            type: 'textarea',
                            key: 'inlineProofreadPrompt',
                            placeholder: $('settings.inlinePromptPlaceholder'),
                            rows: 2,
                        },
                    },
                ],
            },
            {
                name: $('settings.enableInlineEdit'),
                desc: $('settings.enableInlineEditDesc'),
                control: {
                    type: 'toggle',
                    key: 'enableInlineEdit',
                },
            },
            {
                name: $('settings.enableQuickCommands'),
                desc: $('settings.enableQuickCommandsDesc'),
                control: {
                    type: 'toggle',
                    key: 'enableQuickCommands',
                },
            },
            {
                name: $('settings.enableChatHistory'),
                desc: $('settings.chatHistoryDesc'),
                control: {
                    type: 'toggle',
                    key: 'enableChatHistory',
                },
            },
            {
                name: $('settings.chatHistoryFolder'),
                desc: $('settings.chatHistoryFolderDesc'),
                control: {
                    type: 'text',
                    key: 'chatHistoryFolder',
                    placeholder: 'FleurPilot',
                },
            },
        ];
    }

    /**
     * 描述密钥当前保存在哪里，措辞与「密钥保存位置」设置保持一致。
     */
    private secretDesc($: (key: string, fb?: string) => string): string {
        if (!this.plugin.secretStorageAvailable) {
            return $('settings.apiKeyDescUnavailable');
        }
        return this.plugin.secretBackend === 'system'
            ? $('settings.apiKeyDescSystem')
            : $('settings.apiKeyDescVault');
    }
}