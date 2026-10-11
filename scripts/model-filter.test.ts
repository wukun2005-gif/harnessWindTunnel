// 设置屏模型清单过滤：只列对话模型（LLM + 多模态理解），其余品类一律不列。
//
// 判据来自 2026-10 实测百炼 /models 一次回 262 条的真实噪声构成：
// 图像 20 / realtime 29 / tts 17 / asr 6 / speech 4 / audio 4 / embedding 2 / rerank 1。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isChatModel, filterChatModels, filterChatModelInfos } from '../shared/modelFilter'

test('向量与排序模型不列', () => {
  for (const id of [
    'qwen3.7-text-embedding',
    'qwen3.7-text-embedding-flash',
    'text-embedding-3-large',
    'bge-large-zh',
    'gte-base',
    'qwen3.7-text-rerank',
    'bge-reranker-v2-m3',
    'gte-rerank',
  ]) {
    assert.equal(isChatModel(id), false, `${id} 不该出现在设置屏`)
  }
})

test('语音类不列（含 realtime 流式音频）', () => {
  for (const id of [
    'qwen3-tts-instruct-flash',
    'qwen3-asr-flash-2026-02-10',
    'qwen-audio-3.0-asr-flash',
    'MiniMax/speech-2.8-hd',
    'qwen-audio-3.1-realtime-plus',
    'qwen3.8-omni-flash-realtime',      // 带 omni 但是音频流式通道，不是文本对话
    'qwen3.5-livetranslate-flash-realtime',
    'whisper-large-v3',
  ]) {
    assert.equal(isChatModel(id), false, `${id} 不该出现在设置屏`)
  }
})

test('图像与视频生成不列', () => {
  for (const id of [
    'qwen-image-2.1-pro',
    'wan2.7-image',
    'qwen-image-edit-max',
    'dall-e-3',
    'stable-diffusion-xl',
    'flux-1.1-pro',
    'some-video-gen',
  ]) {
    assert.equal(isChatModel(id), false, `${id} 不该出现在设置屏`)
  }
})

test('对话与多模态理解模型全部保留', () => {
  for (const id of [
    'qwen3.7-max',
    'qwen3.8-max',
    'deepseek-v4-pro',
    'glm-5.1',
    'kimi-k2.6',
    'MiniMax-M2.5',
    'qwen3.5-omni-plus',        // 多模态理解
    'qwen3-vl-plus',            // 多模态理解
    'mimo-v2.5-omni',           // 全模态理解
    'qwen3-coder-plus',         // 用途分型，仍是文本生成
    'qwen3-math-plus',
    'qwen-long',
    'qwen3-30b-a3b-instruct-2507',
  ]) {
    assert.equal(isChatModel(id), true, `${id} 是可用对话模型，不该被滤掉`)
  }
})

test('未知型号默认放行，不把厂商新模型静默藏起来', () => {
  // 排除法的关键性质：没见过的新型号一律可选
  assert.equal(isChatModel('some-brand-new-model-2099'), true)
  assert.equal(isChatModel('qwen99-ultra'), true)
  assert.equal(isChatModel(''), false, '空 id 仍然排除')
})

test('过滤保持原顺序，不改写未命中的条目', () => {
  const input = ['qwen-image-max', 'qwen3.8-max', 'qwen3.7-text-embedding', 'glm-5.1']
  assert.deepEqual(filterChatModels(input), ['qwen3.8-max', 'glm-5.1'])
})

test('ModelInfo 列表按 id 过滤且不丢元数据', () => {
  const list = [
    { id: 'qwen-image-max', contextWindow: 0 },
    { id: 'qwen3.8-max', contextWindow: 131072 },
  ]
  const out = filterChatModelInfos(list)
  assert.deepEqual(out.map((m) => m.id), ['qwen3.8-max'])
  assert.equal(out[0]!.contextWindow, 131072, '能力元数据必须跟着一起保留')
})
