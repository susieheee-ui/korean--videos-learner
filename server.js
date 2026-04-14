const express = require('express');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Parse VTT content from yt-dlp into clean subtitle segments
function parseVTT(vttContent) {
  const blocks = vttContent.split(/\n\n+/);
  const rawPieces = [];

  for (const block of blocks) {
    const parts = block.trim().split('\n');
    const tsIdx = parts.findIndex(p => p.includes('-->'));
    if (tsIdx === -1) continue;

    const ts = parts[tsIdx];
    const times = ts.match(/(\d{2}:\d{2}:\d{2}\.\d+)\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d+)/);
    if (!times) continue;

    function toSec(t) {
      const [h, m, s] = t.split(':');
      return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
    }

    const start = toSec(times[1]);
    const end = toSec(times[2]);
    const dur = end - start;

    // Skip transition cues (very short duration ~0.01s)
    if (dur < 0.05) continue;

    const textLines = parts.slice(tsIdx + 1);
    if (textLines.length < 2) continue;

    // In YouTube auto-generated VTT, last line is the new content
    let newText = textLines[textLines.length - 1]
      .replace(/<[^>]+>/g, '')
      .replace(/&gt;&gt;\s*/g, '')
      .replace(/&gt;/g, '').replace(/&lt;/g, '').replace(/&amp;/g, '&')
      .trim();

    if (!newText || /^\[.*\]$/.test(newText)) continue; // skip [음악] etc.

    rawPieces.push({ start, dur, text: newText });
  }

  // Merge fragments into sentences (pause > 1.5s = new sentence)
  const sentences = [];
  let cur = null;

  for (const p of rawPieces) {
    if (!cur) {
      cur = { start: p.start, dur: p.dur, text: p.text, lastStart: p.start };
      continue;
    }

    if (p.start - cur.lastStart < 3.0 && cur.text.length < 100) {
      cur.text += ' ' + p.text;
      cur.dur = (p.start + p.dur) - cur.start;
      cur.lastStart = p.start;
    } else {
      delete cur.lastStart;
      sentences.push(cur);
      cur = { start: p.start, dur: p.dur, text: p.text, lastStart: p.start };
    }
  }
  if (cur) {
    delete cur.lastStart;
    sentences.push(cur);
  }

  return sentences;
}

// Fetch subtitles using yt-dlp
function fetchSubtitlesWithYtDlp(videoId, lang = 'ko') {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const outTemplate = path.join(tmpDir, `kyl_${videoId}`);
    const vttPath = `${outTemplate}.${lang}.vtt`;

    // Clean up previous file if exists
    try { fs.unlinkSync(vttPath); } catch {}

    execFile('yt-dlp', [
      '--write-auto-sub',
      '--sub-lang', lang,
      '--sub-format', 'vtt',
      '--skip-download',
      '-o', outTemplate,
      `https://www.youtube.com/watch?v=${videoId}`
    ], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`yt-dlp failed: ${err.message}`));
      }

      // Check if VTT file was created
      if (!fs.existsSync(vttPath)) {
        // Try manual subs (--write-sub instead of --write-auto-sub)
        execFile('yt-dlp', [
          '--write-sub',
          '--sub-lang', lang,
          '--sub-format', 'vtt',
          '--skip-download',
          '-o', outTemplate,
          `https://www.youtube.com/watch?v=${videoId}`
        ], { timeout: 30000 }, (err2) => {
          if (err2 || !fs.existsSync(vttPath)) {
            return reject(new Error(`No ${lang} subtitles found for this video.`));
          }
          const vtt = fs.readFileSync(vttPath, 'utf-8');
          fs.unlinkSync(vttPath);
          resolve(parseVTT(vtt));
        });
        return;
      }

      const vtt = fs.readFileSync(vttPath, 'utf-8');
      fs.unlinkSync(vttPath);
      resolve(parseVTT(vtt));
    });
  });
}

// API: Fetch Korean subtitles
app.get('/api/subtitles', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) {
    return res.status(400).json({ error: 'Missing videoId parameter' });
  }

  try {
    const subtitles = await fetchSubtitlesWithYtDlp(videoId, 'ko');
    if (subtitles.length === 0) {
      return res.status(404).json({ error: 'No Korean subtitles could be extracted.' });
    }
    res.json({ subtitles });
  } catch (err) {
    console.error('Subtitle fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API: Analyze Korean text using AI
app.post('/api/analyze', async (req, res) => {
  const { lines, provider, apiKey } = req.body;

  if (!lines || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'Missing lines to analyze' });
  }
  if (!apiKey) {
    return res.status(400).json({ error: 'API key is required. Please configure it in settings.' });
  }

  const prompt = `你是一位专业的韩语教师，正在帮助中国学生学习韩语。请分析以下韩语句子，为每句提供：
1. 准确的中文翻译
2. 标注出地道表达（idiom）、语法点（grammar）和重要单词（vocabulary）

请严格按照以下JSON格式返回，不要包含任何其他内容：
{
  "lines": [
    {
      "korean": "原始韩语文本",
      "chinese": "中文翻译",
      "annotations": [
        {
          "text": "被标注的韩语词/语法",
          "type": "vocabulary|grammar|idiom",
          "explanation": "中文解释，包括词性、用法说明等"
        }
      ]
    }
  ]
}

注意事项：
- vocabulary: 标注初中级学习者可能不认识的单词，给出词性和释义
- grammar: 标注语法结构（如终结语尾、连接语尾、助词用法等），解释其功能和使用场景
- idiom: 标注地道表达、惯用语、固定搭配，说明其含义和使用语境
- 每句至少标注2-3个值得学习的点
- 解释要简洁实用，适合中国韩语学习者

需要分析的韩语句子：
${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;

  try {
    let result;

    if (provider === 'openai') {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey });
      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      });
      result = JSON.parse(response.choices[0].message.content);
    } else {
      // Default to Claude
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      });
      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Failed to parse AI response');
      result = JSON.parse(jsonMatch[0]);
    }

    res.json(result);
  } catch (err) {
    console.error('AI analysis error:', err.message);
    res.status(500).json({ error: `AI analysis failed: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`Korean YouTube Learner running at http://localhost:${PORT}`);
});
