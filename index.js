import { getContext } from '../../../extensions.js';
import { ConnectionManagerRequestService } from '../../shared.js';

const EXT_KEY = 'rpBigMemory';
const META_KEY = 'rpBigMemoryState';
const LONG_PROMPT_ID = 'rp-big-memory-long-term';
const ARC_PROMPT_ID = 'rp-big-memory-current-arc';
const MAX_HISTORY = 8;

const DEFAULT_SUMMARY_PROMPT = `你是长期角色扮演聊天的“记忆压缩器”，不是续写模型。

任务目标：把大量聊天历史压缩成供后续模型继续角色扮演时使用的高密度记忆。只记录原文支持的事实，不评价，不续写，不创造新事件，不把推测写成事实。

必须区分：
1. 客观发生的事实；
2. 谁知道/不知道什么；
3. 角色自己的猜测、误解、谎言；
4. 已确认的关系、长期习惯、长期偏好、重要承诺；
5. 已完成但对未来仍有影响的重要事件；
6. 当前仍未解决的事项与正在进行的计划；
7. 当前场景的必要连续性信息。

成人或露骨内容如果对人物关系、长期偏好、边界、习惯、重要第一次、后续连续性有影响，可以用简洁事实语言保留；不要为了避讳而把有效信息改成含糊的“发生了亲密行为”。同时不要复述冗长过程，也不要文学化色情描写。

长期记忆原则：已有长期记忆默认保持不动。只在新历史出现“以后仍值得记住”的新事实时输出新增条目。普通一次性日常、无长期影响的重复行为不要加入长期记忆。

当前篇章原则：用精简但足够续写的语言重写“当前篇章摘要”，让模型知道最近在发生什么、人物当前状态、计划、未完成事项、关系气氛与最近重要变化。

输出必须严格使用以下格式，不要输出其他文字：
<stable_additions>
- 新增长期记忆1
- 新增长期记忆2
</stable_additions>
<current_arc>
当前篇章摘要
</current_arc>

如果没有任何值得加入长期记忆的新事实，在 <stable_additions> 中只输出 NONE。`;

const MAP_SYSTEM_PROMPT = `你是长篇角色扮演聊天的分块压缩器。只压缩给你的这一块历史，不续写、不评价、不创造事实。保留事件因果、人物关系变化、角色认知差、重要承诺与长期习惯、对后续有影响的亲密偏好、未完成事项和场景连续性。成人内容如果对后续连续性有意义，用简洁事实语言保留；不要文学化复述过程。输出高密度项目符号即可。`;

const DEFAULTS = {
    enabled: true,
    apiMode: 'direct',
    directBaseUrl: '',
    directModel: '',
    profileId: '',
    useProfilePreset: true,
    maxOutputTokens: 6000,
    keepRecentMessages: 10,
    longTermDepth: 16,
    arcDepth: 6,
    chunkCharLimit: 90000,
    autoHide: true,
    injectMemory: true,
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
};

let initialized = false;
let registeredListeners = [];
let runtimeApiKey = '';
let activeTab = 'summary';
let busy = false;

function ctx() {
    const c = getContext();
    if (!c) throw new Error('SillyTavern context unavailable');
    return c;
}

function hasActiveChat() {
    const c = ctx();
    return !!c.chatMetadata && Array.isArray(c.chat);
}

function toast(type, message, title = 'RP 大总结') {
    if (window.toastr?.[type]) window.toastr[type](message, title);
    else console[type === 'error' ? 'error' : 'log'](`[${title}] ${message}`);
}

function settings() {
    const c = ctx();
    c.extensionSettings[EXT_KEY] ??= {};
    const s = c.extensionSettings[EXT_KEY];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    return s;
}

function blankState() {
    return {
        schemaVersion: 2,
        longTerm: '',
        currentArc: '',
        summarizedUntil: -1,
        hiddenRanges: [],
        history: [],
        dirty: false,
        dirtyReason: '',
        lastSummaryAt: null,
        lastBackend: '',
        pending: null,
    };
}

function state() {
    const c = ctx();
    if (!c.chatMetadata || typeof c.chatMetadata !== 'object') return blankState();
    if (!c.chatMetadata[META_KEY]) c.chatMetadata[META_KEY] = blankState();
    const st = c.chatMetadata[META_KEY];
    const base = blankState();
    for (const [k, v] of Object.entries(base)) {
        if (st[k] === undefined) st[k] = structuredClone(v);
    }
    return st;
}

async function saveSettings() {
    await ctx().saveSettingsDebounced?.();
}

async function saveState() {
    if (!hasActiveChat()) throw new Error('请先打开一个聊天。');
    await ctx().saveMetadata();
}

function normalizeMemoryText(text) {
    return String(text || '').replace(/\r\n/g, '\n').trim();
}

function uniqueBulletAppend(existing, additions) {
    const oldLines = normalizeMemoryText(existing).split('\n').map(x => x.trim()).filter(Boolean);
    const normalizedOld = new Set(oldLines.map(x => x.replace(/^[-*•]\s*/, '').trim().toLowerCase()));
    const newLines = String(additions || '').split('\n').map(x => x.trim())
        .filter(x => x && !/^none$/i.test(x))
        .map(x => x.replace(/^[-*•]\s*/, '').trim())
        .filter(Boolean)
        .filter(x => {
            const key = x.toLowerCase();
            if (normalizedOld.has(key)) return false;
            normalizedOld.add(key);
            return true;
        })
        .map(x => `- ${x}`);
    return [...oldLines, ...newLines].join('\n').trim();
}

async function updateInjection() {
    const c = ctx();
    const s = settings();
    if (!hasActiveChat()) {
        await c.setExtensionPrompt?.(LONG_PROMPT_ID, '', 1, Number(s.longTermDepth) || 16, false, 0);
        await c.setExtensionPrompt?.(ARC_PROMPT_ID, '', 1, Number(s.arcDepth) || 6, false, 0);
        return;
    }
    const st = state();
    if (!s.enabled || !s.injectMemory) {
        await c.setExtensionPrompt(LONG_PROMPT_ID, '', 1, Number(s.longTermDepth) || 16, false, 0);
        await c.setExtensionPrompt(ARC_PROMPT_ID, '', 1, Number(s.arcDepth) || 6, false, 0);
        return;
    }
    const longText = normalizeMemoryText(st.longTerm);
    const arcText = normalizeMemoryText(st.currentArc);
    await c.setExtensionPrompt(
        LONG_PROMPT_ID,
        longText ? `<rp_long_term_memory>\n以下是已经确认的长期剧情记忆。将其视为过去事实与持续状态，不要把它当作新的事件重复演出。\n${longText}\n</rp_long_term_memory>` : '',
        1,
        Math.max(0, Number(s.longTermDepth) || 16),
        false,
        0,
    );
    await c.setExtensionPrompt(
        ARC_PROMPT_ID,
        arcText ? `<rp_current_arc_memory>\n以下是当前篇章的压缩记忆，用于衔接最近原文。\n${arcText}\n</rp_current_arc_memory>` : '',
        1,
        Math.max(0, Number(s.arcDepth) || 6),
        false,
        0,
    );
}

function profileService() {
    if (!ConnectionManagerRequestService) throw new Error('当前 SillyTavern 没有 ConnectionManagerRequestService。');
    return ConnectionManagerRequestService;
}

function supportedProfiles() {
    try {
        return profileService().getSupportedProfiles() || [];
    } catch (e) {
        console.warn('[RP Big Memory] getSupportedProfiles failed', e);
        return [];
    }
}

function profileLabel(p) {
    const bits = [p.name || p.id];
    if (p.model) bits.push(p.model);
    if (p.preset) bits.push(`Preset: ${p.preset}`);
    return bits.join(' · ');
}

function normalizeBaseUrl(raw) {
    let url = String(raw || '').trim().replace(/\/+$/, '');
    url = url.replace(/\/chat\/completions$/i, '');
    return url;
}

function directModelsUrl() {
    const base = normalizeBaseUrl(settings().directBaseUrl);
    if (!base) throw new Error('请先填写 API Base URL。');
    return `${base}/models`;
}

function directChatUrl() {
    const base = normalizeBaseUrl(settings().directBaseUrl);
    if (!base) throw new Error('请先填写 API Base URL。');
    return `${base}/chat/completions`;
}

function directHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (runtimeApiKey.trim()) headers.Authorization = `Bearer ${runtimeApiKey.trim()}`;
    return headers;
}

async function fetchJson(url, options = {}) {
    let res;
    try {
        res = await fetch(url, options);
    } catch (e) {
        throw new Error(`网络请求失败：${e.message}。如果服务商禁止浏览器跨域请求（CORS），请改用 Connection Profile 模式。`);
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { raw: text }; }
    if (!res.ok) {
        const msg = data?.error?.message || data?.message || data?.raw || `${res.status} ${res.statusText}`;
        throw new Error(`API 返回 ${res.status}：${String(msg).slice(0, 500)}`);
    }
    return data;
}

function extractCompletionContent(data) {
    const messageContent = data?.choices?.[0]?.message?.content;
    if (typeof messageContent === 'string') return messageContent.trim();
    if (Array.isArray(messageContent)) {
        const joined = messageContent.map(x => typeof x === 'string' ? x : (x?.text || x?.content || '')).join('').trim();
        if (joined) return joined;
    }
    if (typeof data?.output_text === 'string') return data.output_text.trim();
    if (typeof data?.text === 'string') return data.text.trim();
    return '';
}

async function sendDirect(messages, maxTokens) {
    const s = settings();
    if (!s.directModel) throw new Error('请先拉取并选择模型，或手动填写模型 ID。');
    const data = await fetchJson(directChatUrl(), {
        method: 'POST',
        headers: directHeaders(),
        body: JSON.stringify({
            model: s.directModel,
            messages,
            max_tokens: Math.max(32, Number(maxTokens) || 6000),
            temperature: 0.2,
            stream: false,
        }),
    });
    const content = extractCompletionContent(data);
    if (!content) throw new Error('副 API 返回成功，但没有找到可用的文本内容。');
    return content;
}

async function sendProfile(messages, maxTokens) {
    const s = settings();
    if (!s.profileId) throw new Error('请先选择 Connection Profile。');
    const result = await profileService().sendRequest(
        s.profileId,
        messages,
        Math.max(32, Number(maxTokens) || 6000),
        {
            stream: false,
            extractData: true,
            includePreset: !!s.useProfilePreset,
            includeInstruct: !!s.useProfilePreset,
        },
    );
    const content = typeof result === 'string' ? result : result?.content;
    if (!content || !String(content).trim()) throw new Error('副 API 返回了空内容。');
    return String(content).trim();
}

async function sendSecondary(messages, maxTokens) {
    return settings().apiMode === 'profile'
        ? sendProfile(messages, maxTokens)
        : sendDirect(messages, maxTokens);
}

function messageToText(m, index) {
    const name = m.name || (m.is_user ? ctx().name1 : ctx().name2) || (m.is_user ? 'User' : 'Character');
    const role = m.is_user ? '用户' : (m.is_system ? '隐藏/系统' : '角色');
    const text = String(m.mes ?? '').trim();
    if (!text) return '';
    return `[#${index}][${role}:${name}]\n${text}`;
}

function collectRange(start, end) {
    const chat = ctx().chat || [];
    const out = [];
    for (let i = Math.max(0, start); i <= Math.min(end, chat.length - 1); i++) {
        const text = messageToText(chat[i], i);
        if (text) out.push({ index: i, text });
    }
    return out;
}

function chunkMessages(items, charLimit) {
    const chunks = [];
    let buf = [];
    let chars = 0;
    const limit = Math.max(10000, Number(charLimit) || 90000);
    for (const item of items) {
        const size = item.text.length + 2;
        if (buf.length && chars + size > limit) {
            chunks.push(buf);
            buf = [];
            chars = 0;
        }
        buf.push(item);
        chars += size;
    }
    if (buf.length) chunks.push(buf);
    return chunks;
}

function chunkRangeLabel(chunk) {
    if (!chunk.length) return '';
    return `#${chunk[0].index}–#${chunk[chunk.length - 1].index}`;
}

function extractTagged(text, tag) {
    const re = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, 'i');
    return text.match(re)?.[1]?.trim() ?? '';
}

function parseFinalSummary(text) {
    const additions = extractTagged(text, 'stable_additions');
    const currentArc = extractTagged(text, 'current_arc');
    if (!currentArc) throw new Error('总结返回格式不完整：找不到 <current_arc>。本次不会写入或隐藏任何楼层。');
    return { additions, currentArc };
}

async function summarizeChunk(chunk, index, total) {
    const range = chunkRangeLabel(chunk);
    const prompt = `你正在执行长聊天压缩的第一阶段。请只压缩下面这一块原文，不续写。\n\n块：${index + 1}/${total}，范围 ${range}\n\n需要保留：事件因果、人物关系变化、谁知道什么、重要承诺与长期习惯、对后续有意义的亲密偏好、未完成事项、场景连续性。普通重复描写尽量删除。\n\n请使用高密度项目符号输出，不要文学化，不要加入原文没有的事实。\n\n<source>\n${chunk.map(x => x.text).join('\n\n')}\n</source>`;
    return sendSecondary([
        { role: 'system', content: MAP_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
    ], Math.min(3200, Number(settings().maxOutputTokens) || 6000));
}

async function buildFinalSummary(sourceItems) {
    const s = settings();
    const st = state();
    const chunks = chunkMessages(sourceItems, s.chunkCharLimit);
    let sourceForFinal;

    if (chunks.length === 1) {
        sourceForFinal = `<new_history>\n${chunks[0].map(x => x.text).join('\n\n')}\n</new_history>`;
    } else {
        const partials = [];
        for (let i = 0; i < chunks.length; i++) {
            setBusyStatus(`正在分块总结 ${i + 1}/${chunks.length} · ${chunkRangeLabel(chunks[i])}`);
            const part = await summarizeChunk(chunks[i], i, chunks.length);
            partials.push(`【分块 ${i + 1}｜${chunkRangeLabel(chunks[i])}】\n${part}`);
        }
        sourceForFinal = `<chunk_summaries>\n${partials.join('\n\n')}\n</chunk_summaries>`;
    }

    const finalPrompt = `请根据已有记忆与本次新历史，生成最终记忆更新。\n\n<existing_long_term>\n${normalizeMemoryText(st.longTerm) || '(空)'}\n</existing_long_term>\n\n<existing_current_arc>\n${normalizeMemoryText(st.currentArc) || '(空)'}\n</existing_current_arc>\n\n${sourceForFinal}\n\n再次强调：已有长期记忆不要重复输出。<stable_additions> 只放真正新增、未来仍值得记住的事实；<current_arc> 则重写成一个自足、精简、可直接续写当前剧情的阶段摘要。严格使用指定标签。`;

    setBusyStatus('正在合并长期记忆与当前篇章…');
    const raw = await sendSecondary([
        { role: 'system', content: s.summaryPrompt },
        { role: 'user', content: finalPrompt },
    ], s.maxOutputTokens);
    return { ...parseFinalSummary(raw), raw, chunkCount: chunks.length };
}

function pushHistorySnapshot(st, note) {
    st.history ??= [];
    st.history.push({
        timestamp: new Date().toISOString(),
        note,
        longTerm: st.longTerm,
        currentArc: st.currentArc,
        summarizedUntil: st.summarizedUntil,
        hiddenRanges: structuredClone(st.hiddenRanges || []),
        dirty: !!st.dirty,
        dirtyReason: st.dirtyReason || '',
    });
    if (st.history.length > MAX_HISTORY) st.history.splice(0, st.history.length - MAX_HISTORY);
}

function rangesDifference(current, previous) {
    const prev = new Set((previous || []).map(r => `${r.start}-${r.end}`));
    return (current || []).filter(r => !prev.has(`${r.start}-${r.end}`));
}

async function slash(command) {
    const c = ctx();
    if (!c.executeSlashCommandsWithOptions) throw new Error('当前 ST 不支持 executeSlashCommandsWithOptions。');
    const result = await c.executeSlashCommandsWithOptions(command);
    if (result?.isError) throw new Error(result.errorMessage || `命令失败：${command}`);
    return result;
}

function getPlannedRange() {
    const s = settings();
    const st = state();
    const chat = ctx().chat || [];
    const start = Math.max(0, Number(st.summarizedUntil) + 1);
    const keep = Math.max(0, Number(s.keepRecentMessages) || 0);
    const end = chat.length - keep - 1;
    return { start, end, keep, total: chat.length };
}

async function summarizeNow() {
    if (!hasActiveChat()) return toast('warning', '请先打开一个聊天。');
    const s = settings();
    const st = state();
    if (s.apiMode === 'direct') {
        if (!s.directBaseUrl) return toast('warning', '先在“副 API”页填写 API 地址。');
        if (!s.directModel) return toast('warning', '先拉取并选择模型。');
    } else if (!s.profileId) {
        return toast('warning', '先选择 Connection Profile。');
    }
    if (st.dirty) return toast('warning', `已总结区域后来发生过修改（${st.dirtyReason || '编辑/Swipe/删除'}）。请先重置此聊天记忆后重新总结。`);

    const { start, end, keep, total } = getPlannedRange();
    if (end < start) return toast('info', `没有足够的新楼层可总结。当前共 ${total} 条，设置保留最近 ${keep} 条。`);
    const items = collectRange(start, end);
    if (!items.length) return toast('info', '选定范围内没有可总结的文本。');

    setControlsDisabled(true);
    setBusyStatus(`读取 #${start}–#${end}，准备调用副 API…`);
    try {
        const result = await buildFinalSummary(items);
        const old = structuredClone(st);
        pushHistorySnapshot(st, `总结前快照 #${start}–#${end}`);
        st.longTerm = uniqueBulletAppend(st.longTerm, result.additions);
        st.currentArc = normalizeMemoryText(result.currentArc);
        st.lastSummaryAt = new Date().toISOString();
        st.lastBackend = s.apiMode === 'direct' ? `${s.directBaseUrl} · ${s.directModel}` : `Profile: ${s.profileId}`;
        st.pending = { start, end, createdAt: new Date().toISOString() };
        await saveState();
        await updateInjection();

        try {
            if (s.autoHide) {
                setBusyStatus(`总结成功，正在隐藏 #${start}–#${end}…`);
                await slash(`/hide ${start}-${end}`);
                st.hiddenRanges.push({ start, end });
            }
            st.summarizedUntil = end;
            st.pending = null;
            await saveState();
            await updateInjection();
            toast('success', `已总结 #${start}–#${end}；保留最近 ${keep} 条原文。${result.chunkCount > 1 ? `共 ${result.chunkCount} 个分块。` : ''}`);
        } catch (hideError) {
            ctx().chatMetadata[META_KEY] = old;
            await saveState();
            await updateInjection();
            throw new Error(`总结已生成，但隐藏/保存失败，已自动回滚：${hideError.message}`);
        }
    } catch (e) {
        console.error('[RP Big Memory] summarize failed', e);
        toast('error', e.message || String(e));
    } finally {
        setControlsDisabled(false);
        setBusyStatus('');
        await refreshUI();
    }
}

async function testApi() {
    setControlsDisabled(true);
    setBusyStatus('正在测试副 API…');
    try {
        const out = await sendSecondary([
            { role: 'system', content: '你是连通性测试。' },
            { role: 'user', content: '只回复 OK。' },
        ], 32);
        toast('success', `副 API 可用：${out.slice(0, 80)}`);
    } catch (e) {
        toast('error', `副 API 测试失败：${e.message}`);
    } finally {
        setControlsDisabled(false);
        setBusyStatus('');
    }
}

async function fetchModels() {
    const s = settings();
    if (!s.directBaseUrl) return toast('warning', '请先填写 API Base URL。');
    const button = document.querySelector('#rp_big_memory_fetch_models');
    if (button) button.disabled = true;
    setBusyStatus('正在拉取模型列表…');
    try {
        const data = await fetchJson(directModelsUrl(), { method: 'GET', headers: directHeaders() });
        const models = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
        const ids = models.map(x => typeof x === 'string' ? x : (x?.id || x?.name || x?.model)).filter(Boolean);
        if (!ids.length) throw new Error('接口返回成功，但没有识别到模型列表。你可以直接手填模型 ID。');
        populateModelSelect(ids);
        if (!s.directModel || !ids.includes(s.directModel)) {
            s.directModel = ids[0];
            await saveSettings();
        }
        setModelControlsFromSettings();
        toast('success', `已拉取 ${ids.length} 个模型。`);
    } catch (e) {
        toast('error', `拉取模型失败：${e.message}`);
    } finally {
        if (button) button.disabled = false;
        setBusyStatus('');
    }
}

async function saveEditedMemory() {
    if (!hasActiveChat()) return toast('warning', '请先打开一个聊天。');
    const st = state();
    pushHistorySnapshot(st, '手动编辑前快照');
    st.longTerm = normalizeMemoryText(document.querySelector('#rp_big_memory_long')?.value ?? st.longTerm);
    st.currentArc = normalizeMemoryText(document.querySelector('#rp_big_memory_arc')?.value ?? st.currentArc);
    await saveState();
    await updateInjection();
    toast('success', '记忆内容已保存。');
    await refreshUI();
}

async function rollback() {
    if (!hasActiveChat()) return toast('warning', '请先打开一个聊天。');
    const st = state();
    const snap = st.history?.pop();
    if (!snap) return toast('info', '没有可回滚的历史版本。');
    try {
        const extraRanges = rangesDifference(st.hiddenRanges, snap.hiddenRanges);
        for (const r of extraRanges) await slash(`/unhide ${r.start}-${r.end}`);
        st.longTerm = snap.longTerm;
        st.currentArc = snap.currentArc;
        st.summarizedUntil = snap.summarizedUntil;
        st.hiddenRanges = structuredClone(snap.hiddenRanges || []);
        st.dirty = !!snap.dirty;
        st.dirtyReason = snap.dirtyReason || '';
        st.pending = null;
        await saveState();
        await updateInjection();
        toast('success', `已回滚到 ${new Date(snap.timestamp).toLocaleString()} 的版本。`);
    } catch (e) {
        toast('error', `回滚失败：${e.message}`);
        st.history.push(snap);
    }
    await refreshUI();
}

async function unhideAll() {
    if (!hasActiveChat()) return toast('warning', '请先打开一个聊天。');
    const st = state();
    if (!st.hiddenRanges?.length) return toast('info', '没有由本插件记录的隐藏范围。');
    try {
        for (const r of st.hiddenRanges) await slash(`/unhide ${r.start}-${r.end}`);
        st.hiddenRanges = [];
        await saveState();
        toast('success', '已恢复插件记录的隐藏楼层。');
    } catch (e) {
        toast('error', `恢复失败：${e.message}`);
    }
    await refreshUI();
}

async function resetChatMemory() {
    if (!hasActiveChat()) return toast('warning', '请先打开一个聊天。');
    const c = ctx();
    const st = state();
    if (!window.confirm('恢复本插件隐藏的楼层，并清空此聊天的大总结、进度和版本历史？原聊天不会删除。')) return;
    try {
        for (const r of st.hiddenRanges || []) await slash(`/unhide ${r.start}-${r.end}`);
    } catch (e) {
        toast('warning', `部分楼层恢复失败：${e.message}`);
    }
    c.chatMetadata[META_KEY] = blankState();
    await saveState();
    await updateInjection();
    toast('success', '当前聊天的大总结状态已重置。');
    await refreshUI();
}

async function markDirty(messageId, reason) {
    if (!hasActiveChat()) return;
    const st = state();
    if (st.summarizedUntil < 0) return;
    const id = Number(messageId);
    if (Number.isFinite(id) && id > st.summarizedUntil) return;
    st.dirty = true;
    st.dirtyReason = `${reason}${Number.isFinite(id) ? ` #${id}` : ''}`;
    await saveState();
    await refreshUI();
}

function setControlsDisabled(disabled) {
    busy = !!disabled;
    document.querySelectorAll('#rp_big_memory_modal button, #rp_big_memory_modal select').forEach(el => {
        if (el.id !== 'rp_big_memory_close') el.disabled = !!disabled;
    });
    document.querySelector('#rp_big_memory_fab')?.classList.toggle('is-busy', !!disabled);
}

function setBusyStatus(text) {
    const el = document.querySelector('#rp_big_memory_busy');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('show', !!text);
}

async function tokenCount(text) {
    try { return await ctx().getTokenCountAsync(String(text || '')); }
    catch { return null; }
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function setTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.rpbm-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
    document.querySelectorAll('.rpbm-page').forEach(x => x.classList.toggle('active', x.dataset.page === tab));
}

function openModal() {
    document.querySelector('#rp_big_memory_overlay')?.classList.add('open');
    document.body.classList.add('rpbm-no-scroll');
    setTab(activeTab);
    refreshUI();
}

function closeModal() {
    document.querySelector('#rp_big_memory_overlay')?.classList.remove('open');
    document.body.classList.remove('rpbm-no-scroll');
}

function populateModelSelect(ids = []) {
    const select = document.querySelector('#rp_big_memory_model_select');
    if (!select) return;
    const current = settings().directModel;
    select.innerHTML = '<option value="">选择已拉取模型</option>';
    for (const id of ids.sort((a, b) => a.localeCompare(b))) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        option.selected = id === current;
        select.appendChild(option);
    }
}

function setModelControlsFromSettings() {
    const s = settings();
    const select = document.querySelector('#rp_big_memory_model_select');
    const manual = document.querySelector('#rp_big_memory_model_manual');
    if (select && [...select.options].some(o => o.value === s.directModel)) select.value = s.directModel;
    if (manual) manual.value = s.directModel || '';
}

function refreshProfileSelect() {
    const select = document.querySelector('#rp_big_memory_profile');
    if (!select) return;
    const s = settings();
    const profiles = supportedProfiles();
    select.innerHTML = '<option value="">选择 Connection Profile</option>';
    for (const p of profiles) {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = profileLabel(p);
        option.selected = p.id === s.profileId;
        select.appendChild(option);
    }
}

function updateApiModeUI() {
    const mode = settings().apiMode;
    document.querySelectorAll('[data-api-mode]').forEach(x => x.classList.toggle('active', x.dataset.apiMode === mode));
    document.querySelector('#rp_big_memory_direct_box')?.classList.toggle('hidden', mode !== 'direct');
    document.querySelector('#rp_big_memory_profile_box')?.classList.toggle('hidden', mode !== 'profile');
}

async function refreshUI() {
    const modal = document.querySelector('#rp_big_memory_modal');
    if (!modal) return;
    const s = settings();
    const activeChat = hasActiveChat();
    const st = state();
    const range = activeChat ? getPlannedRange() : { start: 0, end: -1, keep: Number(s.keepRecentMessages) || 0, total: 0 };

    const status = document.querySelector('#rp_big_memory_status_text');
    if (status) {
        if (!activeChat) status.textContent = '还没有打开聊天';
        else if (st.dirty) status.textContent = `⚠ 记忆可能过期：${st.dirtyReason || '旧楼被修改'}`;
        else if (st.summarizedUntil >= 0) status.textContent = `已总结至 #${st.summarizedUntil}`;
        else status.textContent = '尚未生成大总结';
    }

    const rangeEl = document.querySelector('#rp_big_memory_range_value');
    if (rangeEl) rangeEl.textContent = activeChat && range.end >= range.start ? `#${range.start} → #${range.end}` : '暂无';
    const totalEl = document.querySelector('#rp_big_memory_total_value');
    if (totalEl) totalEl.textContent = activeChat ? `${range.total} 条` : '—';
    const hiddenEl = document.querySelector('#rp_big_memory_hidden_value');
    if (hiddenEl) hiddenEl.textContent = activeChat ? `${st.hiddenRanges?.length || 0} 段` : '—';

    const long = document.querySelector('#rp_big_memory_long');
    const arc = document.querySelector('#rp_big_memory_arc');
    if (long && document.activeElement !== long) long.value = st.longTerm || '';
    if (arc && document.activeElement !== arc) arc.value = st.currentArc || '';

    const [lt, at] = await Promise.all([tokenCount(st.longTerm), tokenCount(st.currentArc)]);
    const size = document.querySelector('#rp_big_memory_size_value');
    if (size) size.textContent = `${lt ?? '—'} + ${at ?? '—'} tk`;
    const longMeta = document.querySelector('#rp_big_memory_long_meta');
    if (longMeta) longMeta.textContent = `${st.longTerm.length.toLocaleString()} 字符${lt !== null ? ` · ~${lt.toLocaleString()} tk` : ''}`;
    const arcMeta = document.querySelector('#rp_big_memory_arc_meta');
    if (arcMeta) arcMeta.textContent = `${st.currentArc.length.toLocaleString()} 字符${at !== null ? ` · ~${at.toLocaleString()} tk` : ''}`;

    document.querySelector('#rp_big_memory_summarize')?.toggleAttribute('disabled', !activeChat || busy);
    document.querySelector('#rp_big_memory_save_memory')?.toggleAttribute('disabled', !activeChat || busy);
    document.querySelector('#rp_big_memory_rollback')?.toggleAttribute('disabled', !activeChat || !st.history?.length || busy);
    document.querySelector('#rp_big_memory_unhide')?.toggleAttribute('disabled', !activeChat || !st.hiddenRanges?.length || busy);

    const apiBadge = document.querySelector('#rp_big_memory_api_badge');
    if (apiBadge) {
        apiBadge.textContent = s.apiMode === 'direct'
            ? (s.directModel ? `直连 · ${s.directModel}` : '直连 · 未选模型')
            : (s.profileId ? 'Connection Profile' : 'Profile 未选择');
    }
    updateApiModeUI();
    setModelControlsFromSettings();
}

function bindInput(id, key, parser = v => v, eventName = 'change') {
    const el = document.querySelector(id);
    if (!el) return;
    const s = settings();
    if (el.type === 'checkbox') el.checked = !!s[key];
    else el.value = s[key] ?? '';
    el.addEventListener(eventName, async () => {
        s[key] = el.type === 'checkbox' ? el.checked : parser(el.value);
        await saveSettings();
        if (['enabled', 'injectMemory', 'longTermDepth', 'arcDepth'].includes(key)) await updateInjection();
        await refreshUI();
    });
}

function buildUI() {
    if (document.querySelector('#rp_big_memory_fab')) return;

    const fab = document.createElement('button');
    fab.id = 'rp_big_memory_fab';
    fab.type = 'button';
    fab.title = 'RP 大总结 / Big Memory';
    fab.setAttribute('aria-label', '打开 RP 大总结');
    fab.innerHTML = '<span>🧠</span>';
    document.body.appendChild(fab);

    const overlay = document.createElement('div');
    overlay.id = 'rp_big_memory_overlay';
    overlay.innerHTML = `
      <section id="rp_big_memory_modal" class="rpbm-modal" role="dialog" aria-modal="true" aria-label="RP 大总结">
        <header class="rpbm-header">
          <div class="rpbm-brand">
            <div class="rpbm-logo">🧠</div>
            <div><h2>Big Memory</h2><p>RP 长期记忆工作台</p></div>
          </div>
          <div class="rpbm-header-actions">
            <span id="rp_big_memory_api_badge" class="rpbm-badge">副 API</span>
            <button id="rp_big_memory_close" class="rpbm-icon-btn" type="button">✕</button>
          </div>
        </header>

        <div class="rpbm-stats">
          <div class="rpbm-stat"><span>状态</span><b id="rp_big_memory_status_text">—</b></div>
          <div class="rpbm-stat"><span>下次压缩</span><b id="rp_big_memory_range_value">—</b></div>
          <div class="rpbm-stat"><span>聊天</span><b id="rp_big_memory_total_value">—</b></div>
          <div class="rpbm-stat"><span>记忆量</span><b id="rp_big_memory_size_value">—</b></div>
        </div>

        <nav class="rpbm-tabs">
          <button class="rpbm-tab active" data-tab="summary">总结</button>
          <button class="rpbm-tab" data-tab="api">副 API</button>
          <button class="rpbm-tab" data-tab="memory">记忆</button>
          <button class="rpbm-tab" data-tab="advanced">高级</button>
        </nav>

        <main class="rpbm-content">
          <section class="rpbm-page active" data-page="summary">
            <div class="rpbm-hero">
              <div><span class="rpbm-eyebrow">NEXT COMPRESSION</span><h3 id="rp_big_memory_summary_range">让旧剧情变成可用的长期记忆</h3><p>总结成功后才会隐藏旧楼；API 失败不会动原文。</p></div>
              <button id="rp_big_memory_summarize" class="rpbm-primary" type="button">🧠 总结并压缩</button>
            </div>
            <div id="rp_big_memory_busy" class="rpbm-busy"></div>
            <div class="rpbm-summary-grid">
              <article class="rpbm-card"><span>保留最近原文</span><strong id="rp_big_memory_keep_preview">10 条</strong><small>最近互动继续保持原汁原味</small></article>
              <article class="rpbm-card"><span>已隐藏历史</span><strong id="rp_big_memory_hidden_value">0 段</strong><small>只是从 Prompt 排除，不删除聊天</small></article>
              <article class="rpbm-card"><span>版本回滚</span><strong id="rp_big_memory_versions_value">0 版</strong><small>总结前自动留下快照</small></article>
            </div>
            <div class="rpbm-inline-actions">
              <button id="rp_big_memory_rollback" class="rpbm-secondary">↩ 回滚一版</button>
              <button id="rp_big_memory_unhide" class="rpbm-secondary">👁 恢复隐藏楼层</button>
            </div>
          </section>

          <section class="rpbm-page" data-page="api">
            <div class="rpbm-section-head"><div><span class="rpbm-eyebrow">SECONDARY MODEL</span><h3>副 API</h3><p>不会切换你的主 RP API。</p></div></div>
            <div class="rpbm-segmented">
              <button type="button" data-api-mode="direct" class="active">🔗 地址 + Key</button>
              <button type="button" data-api-mode="profile">⚙ Connection Profile</button>
            </div>

            <div id="rp_big_memory_direct_box" class="rpbm-api-box">
              <label>API Base URL
                <input id="rp_big_memory_base_url" class="text_pole" placeholder="https://openrouter.ai/api/v1" autocomplete="off">
              </label>
              <label>API Key
                <div class="rpbm-key-row"><input id="rp_big_memory_api_key" class="text_pole" type="password" placeholder="sk-..." autocomplete="new-password"><button id="rp_big_memory_toggle_key" class="rpbm-mini-btn" type="button">显示</button></div>
              </label>
              <div class="rpbm-security-note">🔐 Key 只留在当前网页会话里，不写入扩展设置；刷新页面后需要重新填。UI 扩展本身没有安全的密钥持久化能力。</div>
              <div class="rpbm-model-row">
                <label>模型
                  <select id="rp_big_memory_model_select" class="text_pole"><option value="">先拉取模型</option></select>
                </label>
                <button id="rp_big_memory_fetch_models" class="rpbm-secondary" type="button">↻ 拉取模型</button>
              </div>
              <label>模型 ID（也可手填）
                <input id="rp_big_memory_model_manual" class="text_pole" placeholder="例如 google/gemini-2.5-flash">
              </label>
              <div class="rpbm-inline-actions"><button id="rp_big_memory_test" class="rpbm-primary compact" type="button">测试连接</button></div>
              <div class="rpbm-hint">直连模式按 OpenAI-compatible API 调用 <code>/models</code> 与 <code>/chat/completions</code>。若服务商阻止浏览器跨域请求，请切到 Connection Profile。</div>
            </div>

            <div id="rp_big_memory_profile_box" class="rpbm-api-box hidden">
              <label>Connection Profile
                <select id="rp_big_memory_profile" class="text_pole"><option value="">选择 Profile</option></select>
              </label>
              <label class="rpbm-check"><input id="rp_big_memory_profile_preset" type="checkbox"> 使用该 Profile 绑定的 Settings Preset / Instruct</label>
              <div class="rpbm-inline-actions"><button id="rp_big_memory_refresh_profiles" class="rpbm-secondary" type="button">刷新 Profile</button><button id="rp_big_memory_test_profile" class="rpbm-primary compact" type="button">测试连接</button></div>
            </div>
          </section>

          <section class="rpbm-page" data-page="memory">
            <div class="rpbm-section-head"><div><span class="rpbm-eyebrow">EDITABLE MEMORY</span><h3>当前记忆</h3><p>你可以随时人工修正，再保存回聊天。</p></div><button id="rp_big_memory_save_memory" class="rpbm-primary compact">💾 保存修改</button></div>
            <div class="rpbm-memory-block"><div class="rpbm-memory-title"><b>🔒 长期记忆</b><span id="rp_big_memory_long_meta"></span></div><textarea id="rp_big_memory_long" class="text_pole" rows="13" placeholder="尚无长期记忆"></textarea></div>
            <div class="rpbm-memory-block"><div class="rpbm-memory-title"><b>📖 当前篇章</b><span id="rp_big_memory_arc_meta"></span></div><textarea id="rp_big_memory_arc" class="text_pole" rows="11" placeholder="尚无当前篇章摘要"></textarea></div>
          </section>

          <section class="rpbm-page" data-page="advanced">
            <div class="rpbm-section-head"><div><span class="rpbm-eyebrow">ADVANCED</span><h3>高级设置</h3></div></div>
            <div class="rpbm-options-grid">
              <label>保留最近消息<input id="rp_big_memory_keep" type="number" min="0" max="100" step="1" class="text_pole"></label>
              <label>总结最大输出 tokens<input id="rp_big_memory_max_tokens" type="number" min="512" max="64000" step="256" class="text_pole"></label>
              <label>长期记忆深度 D<input id="rp_big_memory_long_depth" type="number" min="0" max="9999" class="text_pole"></label>
              <label>当前篇章深度 D<input id="rp_big_memory_arc_depth" type="number" min="0" max="9999" class="text_pole"></label>
              <label>单块最大字符数<input id="rp_big_memory_chunk_chars" type="number" min="10000" max="1000000" step="10000" class="text_pole"></label>
            </div>
            <div class="rpbm-toggles">
              <label class="rpbm-check"><input id="rp_big_memory_enabled" type="checkbox"> 启用记忆注入系统</label>
              <label class="rpbm-check"><input id="rp_big_memory_inject" type="checkbox"> 将记忆注入主 RP Prompt</label>
              <label class="rpbm-check"><input id="rp_big_memory_autohide" type="checkbox"> 总结成功后自动隐藏旧楼</label>
            </div>
            <details class="rpbm-details"><summary>总结专用 Prompt</summary><textarea id="rp_big_memory_prompt" class="text_pole" rows="16"></textarea><button id="rp_big_memory_reset_prompt" class="rpbm-secondary">恢复默认 Prompt</button></details>
            <div class="rpbm-danger-zone"><div><b>故障处理</b><p>只清理本插件记忆，不删除聊天。</p></div><button id="rp_big_memory_reset_chat" class="rpbm-danger">重置此聊天记忆</button></div>
          </section>
        </main>
      </section>`;
    document.body.appendChild(overlay);

    fab.addEventListener('click', openModal);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
    overlay.querySelector('#rp_big_memory_close').addEventListener('click', closeModal);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal(); });

    overlay.querySelectorAll('.rpbm-tab').forEach(btn => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
    overlay.querySelectorAll('[data-api-mode]').forEach(btn => btn.addEventListener('click', async () => {
        settings().apiMode = btn.dataset.apiMode;
        await saveSettings();
        updateApiModeUI();
        refreshUI();
    }));

    bindInput('#rp_big_memory_base_url', 'directBaseUrl', v => v.trim());
    bindInput('#rp_big_memory_profile_preset', 'useProfilePreset');
    bindInput('#rp_big_memory_max_tokens', 'maxOutputTokens', Number);
    bindInput('#rp_big_memory_keep', 'keepRecentMessages', Number);
    bindInput('#rp_big_memory_long_depth', 'longTermDepth', Number);
    bindInput('#rp_big_memory_arc_depth', 'arcDepth', Number);
    bindInput('#rp_big_memory_chunk_chars', 'chunkCharLimit', Number);
    bindInput('#rp_big_memory_enabled', 'enabled');
    bindInput('#rp_big_memory_inject', 'injectMemory');
    bindInput('#rp_big_memory_autohide', 'autoHide');

    const keyInput = overlay.querySelector('#rp_big_memory_api_key');
    keyInput.value = runtimeApiKey;
    keyInput.addEventListener('input', () => { runtimeApiKey = keyInput.value; });
    overlay.querySelector('#rp_big_memory_toggle_key').addEventListener('click', e => {
        keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
        e.currentTarget.textContent = keyInput.type === 'password' ? '显示' : '隐藏';
    });

    const modelSelect = overlay.querySelector('#rp_big_memory_model_select');
    const modelManual = overlay.querySelector('#rp_big_memory_model_manual');
    modelSelect.addEventListener('change', async () => {
        if (!modelSelect.value) return;
        settings().directModel = modelSelect.value;
        modelManual.value = modelSelect.value;
        await saveSettings();
        refreshUI();
    });
    modelManual.addEventListener('change', async () => {
        settings().directModel = modelManual.value.trim();
        await saveSettings();
        refreshUI();
    });

    const profile = overlay.querySelector('#rp_big_memory_profile');
    profile.addEventListener('change', async () => {
        settings().profileId = profile.value;
        await saveSettings();
        refreshUI();
    });

    overlay.querySelector('#rp_big_memory_fetch_models').addEventListener('click', fetchModels);
    overlay.querySelector('#rp_big_memory_refresh_profiles').addEventListener('click', refreshProfileSelect);
    overlay.querySelector('#rp_big_memory_test').addEventListener('click', testApi);
    overlay.querySelector('#rp_big_memory_test_profile').addEventListener('click', testApi);
    overlay.querySelector('#rp_big_memory_summarize').addEventListener('click', summarizeNow);
    overlay.querySelector('#rp_big_memory_save_memory').addEventListener('click', saveEditedMemory);
    overlay.querySelector('#rp_big_memory_rollback').addEventListener('click', rollback);
    overlay.querySelector('#rp_big_memory_unhide').addEventListener('click', unhideAll);
    overlay.querySelector('#rp_big_memory_reset_chat').addEventListener('click', resetChatMemory);

    const prompt = overlay.querySelector('#rp_big_memory_prompt');
    prompt.value = settings().summaryPrompt;
    prompt.addEventListener('change', async () => {
        settings().summaryPrompt = prompt.value.trim() || DEFAULT_SUMMARY_PROMPT;
        await saveSettings();
    });
    overlay.querySelector('#rp_big_memory_reset_prompt').addEventListener('click', async () => {
        settings().summaryPrompt = DEFAULT_SUMMARY_PROMPT;
        prompt.value = DEFAULT_SUMMARY_PROMPT;
        await saveSettings();
        toast('success', '已恢复默认总结 Prompt。');
    });

    refreshProfileSelect();
    updateApiModeUI();
    refreshUI();
}

function registerEvents() {
    const c = ctx();
    const es = c.eventSource;
    const et = c.eventTypes;
    if (!es || !et) return;

    const onChat = async () => { await updateInjection(); await refreshUI(); };
    es.on(et.CHAT_CHANGED, onChat);
    registeredListeners.push([et.CHAT_CHANGED, onChat]);

    for (const [eventName, label] of [
        [et.MESSAGE_EDITED, '编辑'],
        [et.MESSAGE_DELETED, '删除'],
        [et.MESSAGE_SWIPED, 'Swipe'],
    ].filter(([name]) => !!name)) {
        const fn = id => markDirty(id, label);
        es.on(eventName, fn);
        registeredListeners.push([eventName, fn]);
    }

    for (const eventName of [et.CONNECTION_PROFILE_CREATED, et.CONNECTION_PROFILE_DELETED, et.CONNECTION_PROFILE_UPDATED].filter(Boolean)) {
        const fn = () => refreshProfileSelect();
        es.on(eventName, fn);
        registeredListeners.push([eventName, fn]);
    }
}

export async function init() {
    if (initialized) return;
    initialized = true;
    settings();
    buildUI();
    registerEvents();
    await updateInjection();
    await refreshUI();
    console.info('[RP Big Memory] v0.2.0 initialized');
}

export async function clean() {
    try {
        const c = ctx();
        for (const [eventName, fn] of registeredListeners) c.eventSource?.removeListener?.(eventName, fn);
        registeredListeners = [];
        await c.setExtensionPrompt(LONG_PROMPT_ID, '', 1, 16, false, 0);
        await c.setExtensionPrompt(ARC_PROMPT_ID, '', 1, 6, false, 0);
        document.querySelector('#rp_big_memory_overlay')?.remove();
        document.querySelector('#rp_big_memory_fab')?.remove();
        document.body.classList.remove('rpbm-no-scroll');
    } catch (e) {
        console.warn('[RP Big Memory] cleanup failed', e);
    }
    initialized = false;
}

async function waitForSillyTavernReady(timeoutMs = 60000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const c = getContext();
            if (c?.extensionSettings && c?.eventSource && c?.eventTypes && document.body) return c;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('等待 SillyTavern 初始化超时。');
}

async function selfStart() {
    try {
        await waitForSillyTavernReady();
        await init();
    } catch (error) {
        console.error('[RP Big Memory] initialization failed', error);
        toast('error', `初始化失败：${error?.message || error}`);
    }
}

void selfStart();
