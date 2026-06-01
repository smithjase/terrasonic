import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { base64, mediaType } = req.body as { base64: string; mediaType: string };
  if (!base64 || !mediaType) {
    return res.status(400).json({ error: 'Missing base64 or mediaType' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const client = new Anthropic({ apiKey });

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType as 'image/jpeg' |'image/png' | 'image/gif' | 'image/webp', data: base64 } },
            { type: 'text', text: 'Read this nature image as if scoring an ambient piece in the spirit of Brian Eno and Jon Hopkins. Judge its emotional FEEM. Respond with ONLY a JSON object, no prose or fences: {"desc":"one evocative sentence","mood":["three","one-word","adjectives"],"valence":0..1 (sombre..joyful),"energy":0..1 (still..intense),"space":0..1 (intimate..vast)}' },
          ],
        },
      ],
    });
    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return res.status(500).json({ error: 'No text response' });
    }
    let text = textBlock.text;
    text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) {
      return res.status(500).json({ error: 'No JSON in response' });
    }
    const json = JSON.parse(text.slice(start, end + 1));
    return res.status(200).json(json);
  } catch (err) {
    console.error('Anthropic API error:', err);
    return res.status(500).json({ error: 'API call failed' });
  }
}
