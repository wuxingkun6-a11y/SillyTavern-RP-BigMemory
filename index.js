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

function ctx() {
    const st = globalThis.SillyTavern || window.SillyTavern;
    if (!st?.getContext) throw new Error('SillyTavern context unavailable');
    return st.getContext();
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
        schemaVersion: 1,
        longTerm: '',
        currentArc: '',
        summarizedUntil: -1,
        hiddenRanges: [],
        history: [],
        dirty: false,
        dirtyReason: '',
        lastSummaryAt: null,
        lastProfileId: '',
        pending: null,
    };
}

function state() {
    const c = ctx();
    if (!c.chatMetadata[META_KEY]) c.chatMetadata[META_KEY] = blankState();
    const st = c.chatMetadata[META_KEY];
    const base = blankState();
    for (const [k, v] of Object.entries(base)) {
        if (st[k] === undefined) st[k] = structuredClone(v);
    }
    return st;
}

async function saveSettings() {
    const c = ctx();
    await c.saveSettingsDebounced?.();
}

async function saveState() {
    await ctx().saveMetadata();
}

function normalizeMemoryText(text) {
    return String(text || '').replace(/\r\n/g, '\n').trim();
}

function uniqueBulletAppend(existing, additions) {
    const oldLines = normalizeMemoryText(existing)
        .split('\n')
        .map(x => x.trim())
        .filter(Boolean);
    const normalizedOld = new Set(oldLines.map(x => x.replace(/^[-*•]\s*/, '').trim().toLowerCase()));
    const newLines = String(additions || '')
        .split('\n')
        .map(x => x.trim())
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
    const c = ctx();
    if (!c.ConnectionManagerRequestService) throw new Error('当前 SillyTavern 没有 ConnectionManagerRequestService，请更新 ST 或启用 Connection Manager。');
    return c.ConnectionManagerRequestService;
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

function refreshProfileSelect() {
    const select = document.querySelector('#rp_big_memory_profile');
    if (!select) return;
    const s = settings();
    const profiles = supportedProfiles();
    select.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = profiles.length ? '请选择副 API Connection Profile' : '没有可用的 Connection Profile';
    select.appendChild(empty);
    for (const p of profiles) {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = profileLabel(p);
        if (p.id === s.profileId) option.selected = true;
        select.appendChild(option);
    }
    refreshProfileInfo();
}

function refreshProfileInfo() {
    const el = document.querySelector('#rp_big_memory_profile_info');
    if (!el) return;
    const s = settings();
    if (!s.profileId) {
        el.textContent = '副 API 不会使用主聊天连接；请先在 Connection Manager 建立一个独立 Profile。';
        return;
    }
    try {
        const p = profileService().getProfile(s.profileId);
        el.textContent = `API: ${p.api || '未知'} ｜ Model: ${p.model || '未指定'} ｜ Profile preset: ${p.preset || '无'}`;
    } catch (e) {
        el.textContent = `Profile 不可用：${e.message}`;
    }
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

async function sendSecondary(messages, maxTokens) {
    const s = settings();
    if (!s.profileId) throw new Error('请先选择副 API Connection Profile。');
    const service = profileService();
    const result = await service.sendRequest(
        s.profileId,
        messages,
        Math.max(256, Number(maxTokens) || 6000),
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

function extractTagged(text, tag) {
    const re = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, 'i');
    return text.match(re)?.[1]?.trim() ?? '';
}

function parseFinalSummary(text) {
    const additions = extractTagged(text, 'stable_additions');
    const currentArc = extractTagged(text, 'current_arc');
    if (!currentArc) {
        throw new Error('总结返回格式不完整：找不到 <current_arc>。为避免污染记忆，本次不会写入或隐藏任何楼层。');
    }
    return { additions, currentArc };
}

async function summarizeChunk(chunk, index, total) {
    const range = chunkRangeLabel(chunk);
    const prompt = `你正在执行长聊天压缩的第一阶段。请只压缩下面这一块原文，不续写。\n\n块：${index + 1}/${total}，范围 ${range}\n\n需要保留：事件因果、人物关系变化、谁知道什么、重要承诺与长期习惯、对后续有意义的亲密偏好、未完成事项、场景连续性。普通重复描写尽量删除。\n\n请使用高密度项目符号输出，不要文学化，不要加入原文没有的事实。\n\n<source>\n${chunk.map(x => x.text).join('\n\n')}\n</source>`;
    return await sendSecondary([
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
            setBusyStatus(`正在分块总结 ${i + 1}/${chunks.length}（${chunkRangeLabel(chunks[i])}）…`);
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
    const snapshot = {
        timestamp: new Date().toISOString(),
        note,
        longTerm: st.longTerm,
        currentArc: st.currentArc,
        summarizedUntil: st.summarizedUntil,
        hiddenRanges: structuredClone(st.hiddenRanges || []),
        dirty: !!st.dirty,
        dirtyReason: st.dirtyReason || '',
    };
    st.history ??= [];
    st.history.push(snapshot);
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
    const s = settings();
    const st = state();
    if (!s.profileId) return toast('warning', '先选择一个副 API Connection Profile。');
    if (st.dirty) {
        return toast('warning', `已总结区域后来发生过修改（${st.dirtyReason || '编辑/Swipe/删除'}）。为避免把旧记忆继续叠上去，请先“重置此聊天记忆”后重新总结。`);
    }

    const { start, end, keep, total } = getPlannedRange();
    if (end < start) {
        return toast('info', `没有足够的新楼层可总结。当前共 ${total} 条，设置保留最近 ${keep} 条。`);
    }
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
        st.lastProfileId = s.profileId;
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
            toast('success', `已总结 #${start}–#${end}；保留最近 ${keep} 条原文。${result.chunkCount > 1 ? `共使用 ${result.chunkCount} 个分块。` : ''}`);
        } catch (hideError) {
            // Roll back memory if hiding/finalization failed.
            ctx().chatMetadata[META_KEY] = old;
            await saveState();
            await updateInjection();
            throw new Error(`总结已生成，但隐藏/保存阶段失败，已自动回滚记忆：${hideError.message}`);
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
    const s = settings();
    if (!s.profileId) return toast('warning', '先选择副 API Profile。');
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

async function saveEditedMemory() {
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
    const st = state();
    if (!st.hiddenRanges?.length) return toast('info', '没有由本插件记录的隐藏范围。');
    try {
        for (const r of st.hiddenRanges) await slash(`/unhide ${r.start}-${r.end}`);
        st.hiddenRanges = [];
        await saveState();
        toast('success', '已恢复本插件记录的隐藏楼层。注意：总结记忆仍会注入，若继续使用完整原文，建议暂时关闭“注入记忆”。');
    } catch (e) {
        toast('error', `恢复失败：${e.message}`);
    }
    await refreshUI();
}

async function resetChatMemory() {
    const c = ctx();
    const st = state();
    const ok = window.confirm('这会恢复本插件隐藏的楼层，并清空当前聊天的大总结、进度和版本历史。不会删除聊天原文。确定吗？');
    if (!ok) return;
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
    document.querySelectorAll('#rp_big_memory_panel button, #rp_big_memory_panel select').forEach(el => {
        if (el.id !== 'rp_big_memory_close') el.disabled = !!disabled;
    });
}

function setBusyStatus(text) {
    const el = document.querySelector('#rp_big_memory_busy');
    if (el) {
        el.textContent = text || '';
        el.style.display = text ? 'block' : 'none';
    }
}

async function tokenCount(text) {
    try {
        return await ctx().getTokenCountAsync(String(text || ''));
    } catch {
        return null;
    }
}

async function refreshUI() {
    const panel = document.querySelector('#rp_big_memory_panel');
    if (!panel) return;
    const s = settings();
    const st = state();
    const range = getPlannedRange();

    const long = document.querySelector('#rp_big_memory_long');
    const arc = document.querySelector('#rp_big_memory_arc');
    if (long && document.activeElement !== long) long.value = st.longTerm || '';
    if (arc && document.activeElement !== arc) arc.value = st.currentArc || '';

    const status = document.querySelector('#rp_big_memory_status');
    if (status) {
        const dirty = st.dirty ? `<span class="rp-mem-danger">⚠ 已总结历史被修改：${escapeHtml(st.dirtyReason || '未知')}</span><br>` : '';
        status.innerHTML = `${dirty}已总结至：<b>${st.summarizedUntil >= 0 ? `#${st.summarizedUntil}` : '尚未总结'}</b> ｜ 下次范围：<b>${range.end >= range.start ? `#${range.start}–#${range.end}` : '暂无'}</b> ｜ 隐藏段：${st.hiddenRanges?.length || 0} ｜ 可回滚：${st.history?.length || 0}`;
    }

    const [lt, at] = await Promise.all([tokenCount(st.longTerm), tokenCount(st.currentArc)]);
    const sizes = document.querySelector('#rp_big_memory_sizes');
    if (sizes) sizes.textContent = `长期记忆：${st.longTerm.length.toLocaleString()} 字符${lt !== null ? ` / ~${lt.toLocaleString()} tokens` : ''} ｜ 当前篇章：${st.currentArc.length.toLocaleString()} 字符${at !== null ? ` / ~${at.toLocaleString()} tokens` : ''}`;

    refreshProfileInfo();
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function bindSetting(id, key, parser = v => v) {
    const el = document.querySelector(id);
    if (!el) return;
    const s = settings();
    if (el.type === 'checkbox') el.checked = !!s[key];
    else el.value = s[key];
    el.addEventListener('change', async () => {
        s[key] = el.type === 'checkbox' ? el.checked : parser(el.value);
        await saveSettings();
        if (['enabled', 'injectMemory', 'longTermDepth', 'arcDepth'].includes(key)) await updateInjection();
        if (key === 'profileId') refreshProfileInfo();
        await refreshUI();
    });
}

function buildPanel() {
    if (document.querySelector('#rp_big_memory_panel')) return;
    const host = document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings2');
    if (!host) return;

    const wrap = document.createElement('div');
    wrap.id = 'rp_big_memory_panel';
    wrap.className = 'extension_container rp-big-memory';
    wrap.innerHTML = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>🧠 RP 大总结 / Big Memory</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="rp-mem-note">副 API 独立总结 → 记忆写入当前聊天 metadata → 注入长期记忆/当前篇章 → 成功后可选隐藏旧楼。原文不会删除。</div>

          <label class="checkbox_label"><input id="rp_big_memory_enabled" type="checkbox"> 启用插件</label>
          <label class="checkbox_label"><input id="rp_big_memory_inject" type="checkbox"> 将记忆注入主 RP Prompt</label>
          <label class="checkbox_label"><input id="rp_big_memory_autohide" type="checkbox"> 总结成功后自动隐藏已处理楼层</label>

          <hr>
          <label>副 API Connection Profile</label>
          <div class="rp-mem-row">
            <select id="rp_big_memory_profile" class="text_pole flex1"></select>
            <button id="rp_big_memory_refresh_profiles" class="menu_button">刷新</button>
            <button id="rp_big_memory_test" class="menu_button">测试</button>
          </div>
          <div id="rp_big_memory_profile_info" class="rp-mem-subtle"></div>
          <label class="checkbox_label"><input id="rp_big_memory_profile_preset" type="checkbox"> 使用该 Connection Profile 绑定的 Settings Preset / Instruct</label>
          <div class="rp-mem-subtle">想用自己的生成参数 / Instruct：在 Connection Manager 新建“总结专用 Profile”并绑定。注意：这不会把主 RP 的整套 Prompt Manager 条目自动复制给副 API；真正的总结/破限前置内容请写进下面可编辑的“总结专用 Prompt”。</div>

          <div class="rp-mem-grid">
            <label>总结最大输出 tokens<input id="rp_big_memory_max_tokens" type="number" min="512" max="64000" step="256" class="text_pole"></label>
            <label>保留最近消息数<input id="rp_big_memory_keep" type="number" min="0" max="100" step="1" class="text_pole"></label>
            <label>长期记忆深度 D<input id="rp_big_memory_long_depth" type="number" min="0" max="9999" step="1" class="text_pole"></label>
            <label>当前篇章深度 D<input id="rp_big_memory_arc_depth" type="number" min="0" max="9999" step="1" class="text_pole"></label>
            <label>单块最大字符数<input id="rp_big_memory_chunk_chars" type="number" min="10000" max="1000000" step="10000" class="text_pole"></label>
          </div>

          <details>
            <summary>总结专用 Prompt（可编辑）</summary>
            <textarea id="rp_big_memory_prompt" class="text_pole rp-mem-prompt" rows="12"></textarea>
            <button id="rp_big_memory_reset_prompt" class="menu_button">恢复默认 Prompt</button>
          </details>

          <hr>
          <div id="rp_big_memory_status" class="rp-mem-status"></div>
          <div id="rp_big_memory_sizes" class="rp-mem-subtle"></div>
          <div id="rp_big_memory_busy" class="rp-mem-busy" style="display:none"></div>
          <div class="rp-mem-row rp-mem-actions">
            <button id="rp_big_memory_summarize" class="menu_button rp-mem-primary">🧠 总结并压缩</button>
            <button id="rp_big_memory_save_memory" class="menu_button">💾 保存手工修改</button>
            <button id="rp_big_memory_rollback" class="menu_button">↩ 回滚一版</button>
          </div>

          <label>🔒 长期记忆（可直接编辑；自动总结只追加新增长期事实）</label>
          <textarea id="rp_big_memory_long" class="text_pole rp-mem-editor" rows="10" placeholder="还没有长期记忆"></textarea>

          <label>📖 当前篇章（可直接编辑；每次总结都会刷新）</label>
          <textarea id="rp_big_memory_arc" class="text_pole rp-mem-editor" rows="10" placeholder="还没有当前篇章摘要"></textarea>

          <details>
            <summary>恢复 / 故障处理</summary>
            <div class="rp-mem-row rp-mem-actions">
              <button id="rp_big_memory_unhide" class="menu_button">👁 恢复本插件隐藏楼层</button>
              <button id="rp_big_memory_reset_chat" class="menu_button redWarningBG">🗑 重置此聊天记忆</button>
            </div>
            <div class="rp-mem-subtle">如果你修改、删除或 Swipe 了“已经总结过”的旧楼层，插件会标记记忆可能过期，并要求重置后重新总结，避免旧摘要继续污染剧情。</div>
          </details>
        </div>
      </div>`;
    host.appendChild(wrap);

    bindSetting('#rp_big_memory_enabled', 'enabled');
    bindSetting('#rp_big_memory_inject', 'injectMemory');
    bindSetting('#rp_big_memory_autohide', 'autoHide');
    bindSetting('#rp_big_memory_profile_preset', 'useProfilePreset');
    bindSetting('#rp_big_memory_max_tokens', 'maxOutputTokens', Number);
    bindSetting('#rp_big_memory_keep', 'keepRecentMessages', Number);
    bindSetting('#rp_big_memory_long_depth', 'longTermDepth', Number);
    bindSetting('#rp_big_memory_arc_depth', 'arcDepth', Number);
    bindSetting('#rp_big_memory_chunk_chars', 'chunkCharLimit', Number);

    const s = settings();
    const prompt = wrap.querySelector('#rp_big_memory_prompt');
    prompt.value = s.summaryPrompt;
    prompt.addEventListener('change', async () => {
        s.summaryPrompt = prompt.value.trim() || DEFAULT_SUMMARY_PROMPT;
        await saveSettings();
    });

    wrap.querySelector('#rp_big_memory_profile').addEventListener('change', async e => {
        s.profileId = e.target.value;
        await saveSettings();
        refreshProfileInfo();
    });
    wrap.querySelector('#rp_big_memory_refresh_profiles').addEventListener('click', refreshProfileSelect);
    wrap.querySelector('#rp_big_memory_test').addEventListener('click', testApi);
    wrap.querySelector('#rp_big_memory_summarize').addEventListener('click', summarizeNow);
    wrap.querySelector('#rp_big_memory_save_memory').addEventListener('click', saveEditedMemory);
    wrap.querySelector('#rp_big_memory_rollback').addEventListener('click', rollback);
    wrap.querySelector('#rp_big_memory_unhide').addEventListener('click', unhideAll);
    wrap.querySelector('#rp_big_memory_reset_chat').addEventListener('click', resetChatMemory);
    wrap.querySelector('#rp_big_memory_reset_prompt').addEventListener('click', async () => {
        s.summaryPrompt = DEFAULT_SUMMARY_PROMPT;
        prompt.value = DEFAULT_SUMMARY_PROMPT;
        await saveSettings();
        toast('success', '已恢复默认总结 Prompt。');
    });

    refreshProfileSelect();
    refreshUI();
}

function registerEvents() {
    const c = ctx();
    const es = c.eventSource;
    const et = c.eventTypes;
    if (!es || !et) return;

    const onChat = async () => {
        await updateInjection();
        await refreshUI();
    };
    es.on(et.CHAT_CHANGED, onChat);
    registeredListeners.push([et.CHAT_CHANGED, onChat]);

    const editEvents = [
        [et.MESSAGE_EDITED, '编辑'],
        [et.MESSAGE_DELETED, '删除'],
        [et.MESSAGE_SWIPED, 'Swipe'],
    ].filter(([name]) => !!name);
    for (const [eventName, label] of editEvents) {
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

let panelObserver = null;

function ensurePanelMounted() {
    buildPanel();
    if (document.querySelector('#rp_big_memory_panel')) return;
    if (panelObserver) return;

    panelObserver = new MutationObserver(() => {
        buildPanel();
        if (document.querySelector('#rp_big_memory_panel')) {
            refreshProfileSelect();
            refreshUI();
            panelObserver?.disconnect();
            panelObserver = null;
        }
    });
    panelObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
}

export async function init() {
    if (initialized) {
        ensurePanelMounted();
        return;
    }
    initialized = true;
    settings();
    ensurePanelMounted();
    registerEvents();
    await updateInjection();
    await refreshUI();
    console.info('[RP Big Memory] v0.1.1 initialized');
}

export async function clean() {
    try {
        panelObserver?.disconnect();
        panelObserver = null;
        const c = ctx();
        for (const [eventName, fn] of registeredListeners) c.eventSource?.removeListener?.(eventName, fn);
        registeredListeners = [];
        await c.setExtensionPrompt(LONG_PROMPT_ID, '', 1, 16, false, 0);
        await c.setExtensionPrompt(ARC_PROMPT_ID, '', 1, 6, false, 0);
        document.querySelector('#rp_big_memory_panel')?.remove();
    } catch (e) {
        console.warn('[RP Big Memory] cleanup failed', e);
    }
    initialized = false;
}


// Third-party extensions are not guaranteed to receive manifest hooks.activate.
// Self-initialize when the page is ready; init() is idempotent, so this is safe
// even on clients that do invoke the manifest hook.
function selfStart() {
    Promise.resolve(init()).catch(error => {
        console.error('[RP Big Memory] initialization failed', error);
        toast('error', `初始化失败：${error?.message || error}`);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', selfStart, { once: true });
} else {
    selfStart();
}
