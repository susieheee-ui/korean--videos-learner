export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey });
      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      });
      result = JSON.parse(response.choices[0].message.content);
    } else {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
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
}
